# Apollo SFS — Project Overview

Apollo SFS is a self-hosted, encrypted file storage platform with a web frontend, mobile apps (iOS and Android), an API backend, and a multi-tier Docker Swarm infrastructure.

## Repository Layout

```
apollo-sfs/
├── api/            # Go 1.26.2 backend (Gin)
├── frontend/       # React 18 / TypeScript / Vite web app
├── mobile/         # React Native 0.86 (iOS + Android)
├── db/             # PostgreSQL 16 schema files and migrations
├── nginx/          # Host nginx config (TLS termination, rate-limiting)
├── fail2ban/       # Fail2ban filter/jail/action for API scan detection
├── keycloak/       # Keycloak 26.0.7 realm, themes, and Apple IdP provider
├── recognition/    # Python AI inference sidecar (faces/pets/objects, ONNX Runtime)
├── test-runner/    # Unified test-runner sidecar (Swarm service — see docker-stack.yml below)
├── docs/           # Architecture and setup documentation
├── docker-compose.yml   # Single-node / development deployment (DEPRECATED — see note below)
└── docker-stack.yml     # Docker Swarm production deployment (actively used)
```

See the `CLAUDE.md` in each subdirectory for component-specific details.

## Infrastructure — Docker Swarm (Two-Node)

Production runs as a two-node Docker Swarm cluster. Images must be pre-built (`build:` is absent from `docker-stack.yml`) and pushed to a registry before deploying.

### Node Roles

| Node | Hardware | Label | Workloads |
|------|----------|-------|-----------|
| **Manager** (server) | Ryzen CPU, amd64, 8 TB HDD | `tier=standard` | API, frontend, Keycloak, Postfix, DDNS, both app databases, standard-tier MinIO, node-metrics-ingest |
| **Worker** (Pi 5) | ARM64, dual NVMe (mergerfs pool) | `tier=fast` | Fast-tier MinIO only |

Apply labels once after initializing the swarm:
```bash
docker node update --label-add tier=standard <manager-node-id>
docker node update --label-add tier=fast <pi5-node-id>
```

### Storage Architecture

- **Fast tier (Pi 5):** Two NVMe drives pooled with mergerfs, mounted and bind-mounted into the fast-tier MinIO container. Best for hot/active files.
- **Standard tier (Manager):** Single 8 TB HDD, used by the standard-tier MinIO container for cold or archival data.
- The Go API routes file writes to the appropriate MinIO instance based on the user's storage tier.

### Deployment

```bash
# Build and push images first (amd64 and arm64)
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/apollo-sfs-api:latest api/ --push
docker buildx build --platform linux/amd64 -t <registry>/apollo-sfs-frontend:latest frontend/ --push

# Deploy or update the stack
docker stack deploy -c docker-stack.yml apollo-sfs

# Check service status
docker stack services apollo-sfs
docker service logs apollo-sfs_api --follow
```

### Service Map

| Service | Port(s) | Node constraint |
|---------|---------|-----------------|
| `frontend` | 3000 (internal) | standard |
| `api` | 8080 (internal) | standard |
| `node-metrics-ingest` | 8080 (internal) | standard |
| `recognition` | 8000 (internal) | standard |
| `keycloak` | 8180 (internal) | standard |
| `postfix` | 587 (internal) | standard |
| `db-app` | 5432 (internal) | standard |
| `db-keycloak` | 5432 (internal) | standard |
| `minio-fast` | 9000 (internal) | fast (Pi 5) |
| `minio-standard` | 9001 (internal) | standard |
| `ddns` | — | standard |
| `test-runner` | 9228 (internal) | standard |

`recognition` is the stateless Python inference sidecar for the premium AI recognition feature (faces/pets/objects): the `api` decrypts media server-side and POSTs plaintext bytes to it over the overlay network (`X-Internal-Token` auth); it never touches keys, the DB, or MinIO. It carries the stack's only `deploy.resources.limits` block — sized to ~50% of the manager's CPU/RAM so indexing can't starve the stack. See `docs/ai_recognition_setup.md` (including how to enable a future NVIDIA GPU).

`node-metrics-ingest` is a small standalone Go service (`api/cmd/node-metrics-ingest`) split out of the `api` service specifically to receive the per-node hardware pushes from `node-agent-standard`/`node-agent-fast` (see the API's `CLAUDE.md`). Keeping it separate isolates that internal, constant-frequency traffic (and any incident on it) from the public-facing `api` service; it shares no in-memory state with `api` — both read/write the same Postgres tables.

`test-runner` is the unified test-runner sidecar backing the admin metrics page's "Run tests" button: one container carrying the Go, Node, and Python toolchains needed to run every suite (backend, frontend Jest + Playwright E2E, mobile Jest, recognition pytest) in sequence, returning one combined JSON report over its own HTTP API (`POST /run-tests`) that the `api` service proxies via `TEST_RUNNER_URL`. Like `recognition`, it is Swarm-only — see `test-runner/CLAUDE.md` for the full design and how to add a new suite.

All services communicate on the `app-network` overlay network. No service ports are exposed directly to the internet; host nginx terminates TLS and proxies inbound traffic.

## Development (Single-Node) — DEPRECATED

**`docker-compose.yml` is deprecated.** It predates the two-node storage-tier split: MinIO now runs as two independent instances — fast-tier NVMe on the Pi 5, standard-tier HDD on the manager — and spreading them across two physical nodes is only expressible in `docker-stack.yml`'s two-node Swarm placement; a single-node compose file has no way to pin a second MinIO instance to a second machine. `docker-stack.yml` is now the only stack actually run/maintained — do not assume `docker-compose.yml` is kept in sync with it (e.g. new services added to `docker-stack.yml`, like `test-runner`, may not have a compose equivalent, or vice versa). Treat it as a historical reference, not a working local dev setup, unless told otherwise.

```bash
# Copy and populate environment file
cp .env.example .env  # edit as needed

# Start everything
docker compose up -d

# Watch API logs
docker compose logs -f api
```

Like `recognition`, the unified `test-runner` sidecar (`test-runner/Dockerfile`, context = repo root) is Swarm-only and has no `docker-compose.yml` equivalent — the admin metrics page's "Run tests" button is inert under compose. Rather than a separate sidecar per service, ONE container carries the Go, Node, and Python toolchains needed to run every suite — backend (`go test`), frontend (Jest + Playwright), mobile (Jest, native modules mocked — no Xcode/Android SDK needed), and recognition (pytest, fake pipelines — no model files/ORT needed) — in sequence, and returns one combined JSON report from `POST /run-tests`. The `api` service calls that endpoint (`TEST_RUNNER_URL`, set only in `docker-stack.yml`) and surfaces the report on the admin metrics page's "Run tests" panel, with a pass/fail + expandable output block per suite. There's no mobile or recognition E2E suite yet (would need Detox/Appium or a live model-serving setup) — only the frontend has a Playwright E2E leg, run against the already-up `frontend` container.

## Environment Variables

All secrets live in `.env` (never commit this file). Key groups:

| Prefix | Purpose |
|--------|---------|
| `POSTGRES_APP_*` | App PostgreSQL credentials |
| `POSTGRES_KC_*` | Keycloak PostgreSQL credentials |
| `MINIO_*` | MinIO root credentials and bucket name |
| `KEYCLOAK_*` | Realm, client, admin, and public URL |
| `KEY_ENCRYPTION_KEY` | Master key for AES-256 per-user key wrapping |
| `SESSION_KEY` | Session cookie signing key |
| `PAYPAL_*` | PayPal credentials — Orders v2 (storage add-ons) + Subscriptions v1 (premium) |
| `GOOGLE_*` | Google OAuth client for web login |
| `CLOUDFLARE_*` | API token (DDNS), Turnstile site/secret keys |
| `SENDGRID_*` | SMTP password (via Postfix relay) and inbound webhook secret |
| `SFS_API_KEY_PEPPER` | Pepper mixed into argon2id API key hashes |
| `RECOGNITION_*` | AI recognition sidecar: shared token, CPU/RAM pool limits, clustering thresholds (see `docs/ai_recognition_setup.md`) |
| `VITE_MS_CLIENT_ID` | Azure AD app (client) ID for the email backup's Microsoft sign-in. Build-time only: deploy.sh passes it to the frontend image build (`--build-arg`), where Vite inlines it into the bundle |
| `TZ` | IANA time zone (e.g. `America/New_York`) for the `api` container's local clock. Used by the daily MinIO/Postgres reconciliation heartbeat, which fires at 4am in this zone — see `docs/storage_reconciliation.md`. Defaults to UTC if unset |

## Networking and Public Access

- All public traffic enters via Cloudflare (Full Strict TLS).
- Host nginx terminates TLS using a Cloudflare Origin Certificate and proxies to Docker services on localhost.
- The `ddns` service updates the Cloudflare DNS A record on IP changes.
- GeoIP filtering in nginx restricts access to US IPs only.
- Fail2ban auto-bans IPs that probe for non-existent API endpoints.

## Logging

Docker logging uses the JSON file driver with rotation (10 MB max, 3 files). Nginx access logs are consumed by fail2ban. Application-level structured logs go to stdout and are captured by Docker.

## Key Documentation

- `docs/apollo-sfs-plan.md` — architecture overview and deployment plan
- `docs/storage_node_setup.md` — multi-tier MinIO node configuration
- `docs/nvme_mount_setup.md` — NVMe drive mounting on Pi 5
- `docs/nvme_capacity_expansion.md` — expanding the mergerfs pool
- `docs/mobile_app_setup.md` — React Native build and release
- `docs/paypal_setup.md` — PayPal payment integration
- `docs/email_backup_setup.md` — Gmail/Microsoft email backup feature (OAuth setup, architecture)
- `docs/ai_recognition_setup.md` — premium AI recognition (models, resource pool, GPU enablement)
- `docs/sfs_api.md` — SFS public API reference
- `docs/file_server_links.md` — premium WebDAV mount links (file server feature)
- `docs/storage_reconciliation.md` — MinIO <-> Postgres reconciliation: drift sources, the daily 4am-local heartbeat, and the admin endpoints for it
