# API Service

Go 1.26.2 REST API built with the Gin web framework. Handles all business logic: file encryption, MinIO storage routing, Keycloak auth verification, billing, and real-time metrics streaming.

## Stack

| Concern | Library |
|---------|---------|
| HTTP framework | `github.com/gin-gonic/gin v1.12.0` |
| PostgreSQL driver | `github.com/lib/pq v1.12.3` |
| MinIO client | `github.com/minio/minio-go/v7 v7.0.100` |
| OIDC verification | `github.com/coreos/go-oidc/v3 v3.18.0` |
| Authorization (RBAC) | `github.com/casbin/casbin/v2 v2.135.0` |
| WebSocket | `github.com/gorilla/websocket v1.5.3` |
| GeoIP | `github.com/oschwald/geoip2-golang v1.13.0` |
| System metrics | `github.com/shirou/gopsutil/v4 v4.26.3` |
| Rate limiting | `golang.org/x/time v0.15.0` |

## Directory Structure

```
api/
├── cmd/
│   ├── main.go                 # Entry point, route registration, server start
│   ├── config.go               # Reads all env vars into a Config struct
│   ├── node-agent/             # Per-node hardware metrics collector (deployed once per Swarm node)
│   └── node-metrics-ingest/    # Standalone ingest service node-agent pushes to (see Node Metrics Ingest below)
├── routes/
│   ├── admin/           # Admin panel endpoints (users, bans, nodes, drive stats, infra)
│   ├── auth/            # Login, register, refresh, mobile auth, social callbacks
│   ├── billing/         # PayPal payment tier endpoints
│   ├── expansion/       # Storage expansion (tier upgrade) flow
│   ├── storage/         # Multi-tier storage management
│   ├── sfs/             # SFS public API endpoints (S3-compatible)
│   ├── dav/             # Premium file-server mounts (WebDAV; no previews/execution)
│   ├── services/        # Internal service layer (business logic shared across routes)
│   ├── middleware/       # Auth, rate-limit, request logging middleware
│   ├── files.go         # File CRUD, upload, download, encryption
│   ├── folders.go       # Folder CRUD
│   ├── media.go         # Video streaming and FFmpeg transcoding
│   ├── me.go            # Current user profile
│   ├── devices.go       # Mobile device registration
│   ├── sync.go          # Mobile sync endpoint
│   └── api_keys.go      # SFS API key management
├── models/              # 39 data model structs (file, folder, user, server, node, …)
├── db/                  # Database connection, query helpers, RLS session setup
├── migrations/          # 58 versioned SQL migration files (run on startup)
├── templates/           # HTML email templates
├── sanitize/            # Input validation and sanitization helpers
├── tests/               # Unit and integration tests
├── Dockerfile                      # Multi-stage Alpine build (main api service)
├── Dockerfile.node-agent           # Per-node metrics collector image
├── Dockerfile.node-metrics-ingest  # Node metrics ingest service image
├── go.mod
└── go.sum
```

## Entry Point

`cmd/main.go`:
1. Loads `.env` via `cmd/config.go`
2. Opens PostgreSQL connection
3. Runs pending migrations from `migrations/`
4. Initializes OIDC provider against Keycloak
5. Registers all route handlers
6. Starts Gin on `:8080`

## Authentication

Every protected route goes through the JWT middleware in `routes/middleware/`. The middleware:
- Validates the Bearer token as a Keycloak-issued JWT via OIDC discovery
- Extracts the Keycloak user UUID (sub claim) and realm roles
- Sets `app.current_user_id` on the PostgreSQL session so Row-Level Security applies

Social login (Google, Apple, Microsoft) goes through `routes/auth/social_callback.go`, which exchanges the IdP token via Keycloak's identity-provider brokering API.

Connecting a provider to an account that already exists (profile page → "Linked accounts" → Connect) is `POST /me/social/link`. It takes the identity three ways: a provider ID token (`token` — what the mobile apps' native SDKs return), a Google server auth code (`server_auth_code`), or a Keycloak authorization code (`code`) for the web, which has no provider SDK and so re-runs the same brokered authorization-code flow the sign-in buttons use. `AuthService.LinkBrokeredIdentity` exchanges that code without provisioning an app user or returning tokens — the caller's session must stay on the account already signed in — then moves the federated identity onto it, refusing (`ErrIdentityClaimed`) if the provider account already belongs to another app account. Note the web flow's `redirect_uri` is the **profile page itself**, not an API callback: the session cookie is `SameSite=Strict`, so it isn't sent on the cross-site redirect back from Keycloak and a callback route would arrive unauthenticated; landing on the SPA lets it forward the code over a same-site XHR that does carry the cookie.

Invite acceptance (`routes/auth/register.go`, `routes/auth/mobile.go`) grants the invitation's realm roles (admin/premium) in Keycloak *before* writing any app DB state or marking the invitation accepted. If that grant fails, `provisionInvitedAppUser` (`routes/services/auth.go`) returns `ErrRoleProvisioningFailed` and the whole request aborts — the invitation stays valid so the recipient can just retry, rather than silently completing with fewer privileges than promised.

## Admin Role Management & Account Deletion

The admin Users page can reassign a user's role or permanently delete their account:

- **`PATCH /admin/users/:user_id/role`** (`routes/admin/users_role.go`) moves a user between exactly one of `admin`/`premium`/`user`. Keycloak is the source of truth — `SetAdminRealmRole`/`AddUserToGroupByName`/`RemoveUserFromGroupByName("premium")` grant or revoke the underlying realm role or group — with the `users` table's `is_admin`/`is_premium` columns set alongside for immediate read consistency (the auth middleware resyncs both from the JWT on every request regardless, so a DB-only change would just be overwritten). Demoting a real subscriber away from `premium` cancels their PayPal subscription first — aborting the whole request on a PayPal failure before any Keycloak/DB write lands — and sends a mandatory cancellation email; demoting straight to `user` can also set `block_future_premium` to stop them from immediately re-purchasing. Promoting to `premium` can set an optional `premium_expires_at` for an admin-granted trial. Every change requires a `reason` string, recorded in `role_change_notifications` (`db/role_change_notifications.go`) and surfaced to the affected user as a `role_changed` notification-bell item.
- **`DELETE /admin/users/:user_id`** (`routes/admin/users_delete.go`) permanently removes an account: cancels any real PayPal subscription, sends the mandatory deletion email (before the row is gone — `email_queue` keeps its own copy of the address), purges files and folders, deletes the Keycloak identity, then deletes the `users` row. Every step but the final row deletion is best-effort/logged rather than a hard failure, mirroring `BanUser`'s tolerance for partial failure.
- **Premium trial expiry**: `PaymentService.PremiumExpiryLoop` (`routes/services/payment.go`), started from `cmd/main.go` alongside the other background loops, sweeps `premium_expires_at` every 15 minutes and revokes access the same way a manual demotion would once a trial lapses.

## Encryption Model

- Each user has a per-user AES-256-GCM key.
- That key is encrypted under the master key (`KEY_ENCRYPTION_KEY`) and stored in the `users` table (`encrypted_key`, `key_nonce`).
- File contents are encrypted before upload to MinIO; the nonce is stored in the `files` table.
- Key rotation is tracked in `master_keys` and `key_rotation_log` tables.

## Multi-Tier Storage

The API maintains connections to two MinIO instances:
- **Fast tier** — Pi 5 (NVMe pool): hot/active files
- **Standard tier** — Manager node (8 TB HDD): cold/archival files

Routing logic in `routes/storage/` determines which MinIO instance receives each upload based on the user's assigned tier.

## Fair Upload Bandwidth Cap

`services.BandwidthManager` (`routes/services/bandwidth.go`) keeps one user's
large upload from saturating the server's link and starving everyone else,
without a manually configured speed limit: the budget is derived live from
the periodic WAN speed test (`routes/admin/speedtest.go`, Cloudflare probe,
every 30 min) — `(measured speed − reserve) ÷ number of users currently
mid-upload`, where reserve is `min(100 Mbps, 15% of measured speed)`. A lone
uploader gets the whole budget; concurrent uploaders split it evenly, live,
as they start and finish (`Acquire`/`release`, keyed by user ID so a user's
several parallel chunk requests count once).

To avoid the obvious feedback loop — uploads competing with the speed test
for the same link would make it under-report capacity, shrinking the budget
based on a reading the uploads themselves suppressed — only a probe with zero
active uploads both immediately before and immediately after it ran is
trusted to feed the budget (`Handler.runAndRecordSpeedTest`,
`Handler.CleanNetworkSpeedMbps` implementing `services.NetworkSpeedSource`).
Every probe still updates the existing display/alarm-facing result
regardless; only the budget-feeding "clean" cache is gated. No cap is applied
at all until a clean sample exists.

A hard cap (`maxConsecutiveUncleanSpeedTests = 48`, ~24h at the 30-min loop
cadence) prevents an always-busy server from going indefinitely without a
budget update: `recordSpeedTestSample` tracks a streak of unclean/failed
probes plus the least-loaded successful one seen in it, and once the streak
hits 48 forces a promotion regardless — the least-dirty candidate (tier 1),
or, if every probe in the streak errored outright, a flat assumed
`fallbackBudgetMbps = 900` reading (tier 2). Either fallback promotion is
tagged with `SpeedTestResult.FallbackReason` and logged, so it's visible
that the budget came from a fallback rather than a genuinely clean
measurement.

The throttle wraps `http.Request.Body` (`Handler.throttleUploadBody`,
`routes/files.go`) before Gin's `FormFile`/`PostForm` parse it — parsing is
what actually pulls bytes off the socket, so throttling anything after that
point wouldn't affect real network throughput. See
`docs/upload_bandwidth_fairness.md` for the full design.

## Rate Limiting

`routes/middleware/rate_limit.go` has three tiers, all token buckets with a
background eviction sweep:

- **Auth endpoints** (`RateLimit()`) — 10 req/min per IP, burst 10.
- **Authenticated API** (`APIRateLimit()`) — 120 req/min per IP, burst 20.
  Applied to the whole `protected` group.
- **Bulk data path** (`bulkDataRoutes`, inside `APIRateLimit()`) — 1200 req/min
  **per user**, burst 60. Uploads, `/sync/check-hash`, the email-backup message
  endpoint, and per-item deletes are hit once per file by a legitimate client
  (Google/email backup, multi-select delete), which the standard budget cut off
  within a handful of files. Keying by user id rather than IP also keeps one
  member of a NAT'd household from spending everyone else's budget. Abuse is
  still bounded by the storage quota these endpoints enforce.

Matching is on `METHOD + c.FullPath()`, so a renamed route silently drops back
to the standard budget — `TestBulkDataRoutesStillExist` guards the map against
`cmd/main.go`. The frontend additionally retries a 429 with backoff
(`frontend/src/api/client.ts`), since the request is refused before the handler
runs and can always be repeated.

## Row-Level Security

All `files` and `folders` queries are executed after calling `db.Queries.ForUser(userID)`, which sets the `app.current_user_id` session variable. PostgreSQL RLS policies on those tables reject any row not owned by the current user, preventing cross-user data leakage even if there is a bug in the application query.

## Video Transcoding

`routes/media.go` accepts video uploads, stores the original, then enqueues a background FFmpeg transcode. Variants (lower resolution) are stored in MinIO and tracked in the `video_variants` table with statuses `pending`, `ready`, or `failed`. Streaming uses range requests and WebSocket for real-time progress.

## AI Recognition (Premium)

Per-collection face/pet/object indexing. `routes/services/recognition.go` owns
the durable job queue (`recognition_jobs`, claimed with FOR UPDATE SKIP LOCKED
and interleaved per-user so no single user monopolizes it) and a background
worker started next to the email worker in `cmd/main.go`. Per file it decrypts
the media (same path as transcoding), samples video frames with FFmpeg, POSTs
plaintext bytes to the `recognition` sidecar (`RECOGNITION_URL`,
`X-Internal-Token`), stores detections + encrypted quota-counted crops, and
cluster-assigns embeddings into `recognition_groups` via incremental centroid
matching (`recognition_cluster.go`, embeddings as BYTEA — no pgvector).
Endpoints are premium-gated in `routes/recognition.go`; lifecycle events audit
to `audit_logs`. See `docs/ai_recognition_setup.md`.

## Storage Reconciliation

MinIO and Postgres are updated as two separate steps on every upload/delete
(never one atomic transaction), so a crash or partial failure between them can
leave an object orphaned in MinIO or a DB row pointing at a since-deleted
object ("ghost files"). `services.ReconciliationService`
(`routes/services/reconciliation.go`) is the safety net: once a day at 4am
server-local time (`DailyLoop`, started from `cmd/main.go`; also reachable
on demand via `POST /admin/system/reconciliation`), it lists every active
drive's MinIO bucket, diffs it against `files`/`video_variants`/
`recognition_detections`, and auto-repairs what it finds — deleting orphan
objects, deleting ghost rows (a ghost `files` row goes through the normal
`FileService.Delete` path so the quota refund matches a real delete), and
aborting abandoned incomplete multipart uploads. Every action is recorded in
`reconciliation_runs`/`reconciliation_findings` (`GET /admin/system/reconciliation`
shows the latest run). See `docs/storage_reconciliation.md` for the full design,
including why variant/crop objects are diffed fleet-wide rather than per-drive.

## Real-Time Metrics

`routes/admin/infrastructure.go` streams server metrics (CPU, RAM, disk) over WebSocket using `gopsutil`. The frontend connects via `hooks/useMetricsStream.ts`.

Per-node hardware metrics (CPU, memory, network, drive temps/capacity) are collected by a separate `node-agent` process deployed once per Swarm node (`cmd/node-agent`), which pushes samples every ~5s to the `node-metrics-ingest` service — its own standalone binary and Swarm service (see below), not a route on this `api` process. `MetricsService` (`routes/services/metrics.go`) reads those pushes back from Postgres (`NodeStates()`) to assemble the combined cluster + per-node frame broadcast over the WebSocket above; it holds no in-memory node state.

### Node Metrics Ingest (`cmd/node-metrics-ingest`)

A small standalone Go binary/Swarm service, split out of `api` so this internal, constant-frequency traffic (and any incident on it) never touches the public-facing API:
- Connects directly to Postgres (same `POSTGRES_APP_*` credentials as `api`) — it does **not** run migrations; `api` owns those.
- Exposes `POST /internal/node-metrics` (auth: shared-secret `X-Internal-Token`, checked against `NODE_AGENT_TOKEN`) and `GET /healthz`.
- Uses `services.NodeIngestService` (`routes/services/node_ingest.go`) to persist each push — no in-memory state, no WebSocket hub.
- Deployed manager-only (`tier=standard`) in `docker-stack.yml`, reachable only over the `app-network` overlay network; never proxied by nginx.
- `node-agent` targets it via `NODE_METRICS_INGEST_URL` (default `http://node-metrics-ingest:8080`).

## Building

```bash
# Local build (builds every cmd/ binary: api, node-agent, node-metrics-ingest)
cd api
go build ./cmd/...

# Docker image (multi-stage, produces a minimal Alpine binary)
docker build -t apollo-sfs-api .
docker build -f Dockerfile.node-metrics-ingest -t apollo-sfs_node-metrics-ingest .

# Cross-compile for arm64 (Pi 5)
GOOS=linux GOARCH=arm64 go build -o api-arm64 ./cmd/...
```

`./deploy.sh` (repo root) automates building/pushing/deploying all of these images against the Swarm stack — see its `--help`.

## Testing

```bash
# Run unit tests
go test ./...

# The full cross-service suite (backend/frontend/frontend-E2E/mobile/recognition)
# runs via the unified test-runner Swarm service (docker-stack.yml) — Swarm-only,
# no docker-compose.yml equivalent (deprecated, see root CLAUDE.md). Normally
# triggered from the admin metrics page's "Run tests" button; to trigger
# manually from the manager, see test-runner/CLAUDE.md.
```

The old `api/Dockerfile.test` sidecar image and its `cmd/testserver` entrypoint were removed in favor of the unified `test-runner/` sidecar (repo root) — `TEST_RUNNER_URL` replaces the old `BACKEND_TEST_URL`. `APP_DIR` still works as a local-dev fallback for just the backend suite when `TEST_RUNNER_URL` is unset (see `routes/admin/tests.go`).

## Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `POSTGRES_APP_USER` / `_PASSWORD` / `_DB` | App database credentials |
| `MINIO_ROOT_USER` / `_ROOT_PASSWORD` | MinIO admin credentials |
| `MINIO_BUCKET_NAME` | Primary storage bucket |
| `KEYCLOAK_REALM` | Keycloak realm name |
| `KEYCLOAK_CLIENT_ID` / `_CLIENT_SECRET` | Confidential client for token introspection |
| `KEYCLOAK_PUBLIC_URL` | Used to construct OIDC discovery URL |
| `KEY_ENCRYPTION_KEY` | Base64-encoded 32-byte master encryption key |
| `SESSION_KEY` | Session cookie HMAC signing key |
| `PAYPAL_CLIENT_ID` / `_CLIENT_SECRET` / `_WEBHOOK_ID` | PayPal primary/live client — Orders v2 (storage add-ons) + Subscriptions v1 (premium). Always used against PayPal's live API; there is no env-driven sandbox mode for this client. |
| `PAYPAL_SANDBOX_CLIENT_ID` / `_CLIENT_SECRET` / `_WEBHOOK_ID` | Optional second, always-sandbox PayPal client — backs the admin-only "sandbox payments" session toggle (profile page), validated server-side against the caller's JWT admin role. Empty disables the toggle regardless of its state. This is the only way to route payments to sandbox. |
| `PAYPAL_PLAN_ID_MONTHLY` / `_ANNUAL` | Live PayPal Billing Plan ids premium subscriptions are created against (see `docs/paypal_setup.md`) |
| `PAYPAL_SANDBOX_PLAN_ID_MONTHLY` / `_ANNUAL` | Sandbox-app counterparts, used when the sandbox-payments toggle is on |
| `GOOGLE_WEB_CLIENT_ID` / `_OAUTH_CLIENT_SECRET` | Google OAuth for social login |
| `CLOUDFLARE_TURNSTILE_SECRET_KEY` | Server-side Turnstile verification |
| `SFS_API_KEY_PEPPER` | Mixed into argon2id hashes for SFS API keys |
| `QUOTA_WARNING_THRESHOLD_PERCENT` | Triggers quota warning emails |
| `RECOGNITION_URL` / `RECOGNITION_TOKEN` | AI recognition sidecar endpoint + shared secret (empty URL disables the feature) |
| `RECOGNITION_CONCURRENCY` / `RECOGNITION_MAX_KEYFRAMES` | Worker parallelism and video frame sampling |
| `RECOGNITION_FACE_THRESHOLD` / `RECOGNITION_PET_THRESHOLD` | Clustering cosine thresholds |
| `DISK_STATS_DRIVE_LABEL` | Mount label used for drive capacity reports |

## Adding a Route

1. Create a handler function in the appropriate `routes/` subdirectory.
2. Register it in `cmd/main.go` under the correct route group (apply the auth middleware for protected routes).
3. Add the corresponding model struct in `models/` if new DB tables are involved.
4. Write a migration in `migrations/` for any schema changes.
