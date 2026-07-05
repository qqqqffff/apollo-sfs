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
│   ├── dav/             # Premium file-server mounts (WebDAV, upload/download only)
│   ├── services/        # Internal service layer (business logic shared across routes)
│   ├── middleware/       # Auth, rate-limit, request logging middleware
│   ├── files.go         # File CRUD, upload, download, encryption
│   ├── folders.go       # Folder CRUD
│   ├── media.go         # Video streaming and FFmpeg transcoding
│   ├── me.go            # Current user profile
│   ├── devices.go       # Mobile device registration
│   ├── sync.go          # Mobile sync endpoint
│   └── api_keys.go      # SFS API key management
├── models/              # 24 data model structs (file, folder, user, server, node, …)
├── db/                  # Database connection, query helpers, RLS session setup
├── migrations/          # 20 versioned SQL migration files (run on startup)
├── templates/           # HTML email templates
├── sanitize/            # Input validation and sanitization helpers
├── tests/               # Unit and integration tests
├── Dockerfile                      # Multi-stage Alpine build (main api service)
├── Dockerfile.test                 # Test runner sidecar image
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

Social login (Google, Apple) goes through `routes/auth/social_callback.go`, which exchanges the IdP token via Keycloak's identity-provider brokering API.

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

## Row-Level Security

All `files` and `folders` queries are executed after calling `db.Queries.ForUser(userID)`, which sets the `app.current_user_id` session variable. PostgreSQL RLS policies on those tables reject any row not owned by the current user, preventing cross-user data leakage even if there is a bug in the application query.

## Video Transcoding

`routes/media.go` accepts video uploads, stores the original, then enqueues a background FFmpeg transcode. Variants (lower resolution) are stored in MinIO and tracked in the `video_variants` table with statuses `pending`, `ready`, or `failed`. Streaming uses range requests and WebSocket for real-time progress.

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

# Via Docker sidecar (matches CI) — NOTE: docker-compose.yml is deprecated
# (see root CLAUDE.md); this sidecar has no docker-stack.yml equivalent yet.
docker compose run api-tests
```

The `Dockerfile.test` sidecar runs the full test suite against a live database and MinIO, matching the production environment as closely as possible.

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
| `PAYPAL_CLIENT_ID` / `_CLIENT_SECRET` / `_WEBHOOK_ID` | PayPal Orders v2 |
| `PAYPAL_ENV` | `sandbox` or `live` |
| `GOOGLE_WEB_CLIENT_ID` / `_OAUTH_CLIENT_SECRET` | Google OAuth for social login |
| `CLOUDFLARE_TURNSTILE_SECRET_KEY` | Server-side Turnstile verification |
| `SFS_API_KEY_PEPPER` | Mixed into argon2id hashes for SFS API keys |
| `QUOTA_WARNING_THRESHOLD_PERCENT` | Triggers quota warning emails |
| `DISK_STATS_DRIVE_LABEL` | Mount label used for drive capacity reports |

## Adding a Route

1. Create a handler function in the appropriate `routes/` subdirectory.
2. Register it in `cmd/main.go` under the correct route group (apply the auth middleware for protected routes).
3. Add the corresponding model struct in `models/` if new DB tables are involved.
4. Write a migration in `migrations/` for any schema changes.
