# Apollo SFS

A self-hosted encrypted file storage service. Files are encrypted at rest with per-user AES-256-GCM keys wrapped under a rotating master key. Storage, authentication, email, and metrics run as Docker containers on a Raspberry Pi behind Cloudflare.

## Architecture

```
Internet → Cloudflare (proxy) → Host nginx (TLS termination, host process)
                                      ├── :3000 → frontend  (React/Vite)
                                      └── :8080 → api       (Go/Gin)
                                                       ├── db-app    (PostgreSQL)
                                                       ├── keycloak  (OIDC/auth)
                                                       ├── postfix   (SMTP relay)
                                                       ├── minio-standard  (8 TB HDD, cold storage)
                                                       └── minio-fast      (Pi 5 NVMe pool, hot storage)
```

### Production — Two-Node Docker Swarm

| Node | Hardware | Swarm role | Label | Workloads |
|------|----------|-----------|-------|-----------|
| **Manager** | Ryzen, amd64, 8 TB HDD | manager | `tier=standard` | API, frontend, Keycloak, Postfix, DDNS, both databases, standard-tier MinIO |
| **Worker (Pi 5)** | ARM64, dual NVMe (mergerfs pool) | worker | `tier=fast` | Fast-tier MinIO only |

nginx and fail2ban run **on the manager host**, not inside Docker. All application services run as Docker Swarm services on the `app-network` overlay network. No service ports are exposed directly to the internet.

---

## Prerequisites

- Raspberry Pi running a 64-bit OS (Raspberry Pi OS Bookworm or Ubuntu 24.04)
- Docker Engine + Docker Compose plugin
- nginx installed on the host (`sudo apt install nginx`)
- A domain managed by Cloudflare with the proxy (orange cloud) enabled
- An NVMe drive (or any mount point) for MinIO data at `/minio/nvme-1/data`

---

## 1 — Clone the repository

```bash
git clone <your-repo-url> /home/<user>/apollo-sfs
cd /home/<user>/apollo-sfs
```

---

## 2 — Create the MinIO data directory

The compose file bind-mounts MinIO's data to `./minio/nvme-01/data` (relative to the project root). Create it before the first `docker compose up`:

```bash
mkdir -p /home/apollo/apollo-sfs/minio/nvme-01/data
sudo chown -R 1000:1000 /home/apollo/apollo-sfs/minio/nvme-01/data
```

If your NVMe is mounted elsewhere, update the `device` path in the `minio-data` volume at the bottom of `docker-compose.yml`.

---

## 3 — Cloudflare TLS certificate

Apollo SFS uses a Cloudflare Origin Certificate so that Cloudflare's edge validates the Pi's TLS cert (Full Strict mode). A self-signed cert will not work.

1. Go to **Cloudflare Dashboard → SSL/TLS → Origin Server → Create Certificate**
2. Choose RSA 2048, set a validity period (up to 15 years)
3. Copy the certificate and private key into:

```bash
sudo mkdir -p /etc/ssl/cloudflare
sudo nano /etc/ssl/cloudflare/origin.crt   # paste the certificate
sudo nano /etc/ssl/cloudflare/origin.key   # paste the private key
sudo chmod 600 /etc/ssl/cloudflare/origin.key
```

4. In Cloudflare, set **SSL/TLS encryption mode** to **Full (Strict)**.

---

## 4 — Host nginx configuration

The project ships a complete `nginx.conf` (with gzip, rate-limiting, and logging already configured) and a site config. Replace the system defaults entirely — do not merge:

```bash
# Replace the main nginx config (includes the rate-limit zone the site config needs)
sudo cp nginx/nginx.conf /etc/nginx/nginx.conf

# Drop the site config into conf.d (it is already included by nginx.conf)
sudo cp nginx/conf.d/apollo-sfs.conf /etc/nginx/conf.d/apollo-sfs.conf

# Remove the default placeholder site if present
sudo rm -f /etc/nginx/conf.d/default.conf /etc/nginx/sites-enabled/default

# Test config and reload
sudo nginx -t && sudo systemctl reload nginx
```

---

## 5 — Environment file

Create `.env` in the project root. All values marked **required** must be set — the API will refuse to start without them.

```env
# ── PostgreSQL — app DB ────────────────────────────────────────────────────────
POSTGRES_APP_USER=apollo
POSTGRES_APP_PASSWORD=<strong-password>
POSTGRES_APP_DB=apollo_sfs

# ── PostgreSQL — Keycloak DB ───────────────────────────────────────────────────
POSTGRES_KC_USER=keycloak
POSTGRES_KC_PASSWORD=<strong-password>
POSTGRES_KC_DB=keycloak

# ── MinIO ──────────────────────────────────────────────────────────────────────
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=<strong-password>
MINIO_BUCKET_NAME=apollo-sfs

# ── Keycloak ───────────────────────────────────────────────────────────────────
KEYCLOAK_REALM=apollo
KEYCLOAK_CLIENT_ID=apollo-sfs-api
KEYCLOAK_CLIENT_SECRET=<client-secret-from-keycloak>
KEYCLOAK_ADMIN=admin
KEYCLOAK_ADMIN_PASSWORD=<strong-password>

# ── Encryption ─────────────────────────────────────────────────────────────────
# 32 random bytes, hex-encoded. Generate with:
#   openssl rand -hex 32
KEY_ENCRYPTION_KEY=<64-hex-chars>

# ── Session cookie ─────────────────────────────────────────────────────────────
# 32 or 64 random bytes, any encoding. Generate with:
#   openssl rand -base64 48
SESSION_KEY=<random-secret>

# ── Domain & cookies ───────────────────────────────────────────────────────────
COOKIE_DOMAIN=files.example.com
COOKIE_SECURE=true
APP_BASE_URL=https://files.example.com

# ── Email (Postfix → SendGrid) ─────────────────────────────────────────────────
POSTFIX_INTERNAL_HOST=postfix:587
MAIL_FROM=noreply@example.com
MAIL_DOMAIN=example.com
SENDGRID_SMTP_PASSWORD=<sendgrid-api-key>

# ── Cloudflare DDNS ────────────────────────────────────────────────────────────
# Scoped API token with DNS Edit permission only (not a global API key).
CLOUDFLARE_API_TOKEN=<token>
CLOUDFLARE_RECORD_NAME=files.example.com

# ── Optional tunables ──────────────────────────────────────────────────────────
TOKEN_REFRESH_THRESHOLD=60          # seconds before expiry to proactively refresh
QUOTA_WARNING_THRESHOLD_PERCENT=80  # send quota warning email above this %
```

---

## 6 — Keycloak realm setup

The realm is imported automatically on first boot if you place a realm export JSON in the right directory. If you are setting up from scratch:

### Option A — import an existing realm export

```bash
mkdir -p keycloak/import
cp your-realm-export.json keycloak/import/realm-export.json
```

### Option B — configure manually after first boot

1. Start only Keycloak and its database first (see step 8)
2. Log in at `http://<pi-ip>:8180` with `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`
3. Create a realm named to match `KEYCLOAK_REALM` (e.g. `apollo`)
4. Create a client:
   - **Client ID**: matches `KEYCLOAK_CLIENT_ID`
   - **Client authentication**: On (confidential)
   - **Standard flow**: enabled; **Direct access grants**: disabled
   - Valid redirect URIs: `https://files.example.com/*`
   - Web origins: `https://files.example.com`
5. Copy the **Client Secret** from the Credentials tab → set `KEYCLOAK_CLIENT_SECRET` in `.env`
6. Under **Realm Settings → Login**, enable user registration only if you want open sign-up (leave off to use invitations only)

---

## 7 — SMTP relay configuration

The `postfix` service uses `boky/postfix` — a multi-arch Postfix image that relays outbound mail through SendGrid. It is fully configured via the environment variables already set in your `.env` file (`MAIL_DOMAIN`, `SENDGRID_SMTP_PASSWORD`). No extra config file is needed.

The Go API connects to this relay at `postfix:587` via the `POSTFIX_INTERNAL_HOST` environment variable.

If you want to verify the relay is working after first launch:

```bash
docker exec -it apollo-sfs-postfix sh -c \
  "echo 'Test body' | mail -s 'Test' your@email.com"
docker compose logs postfix
```

---

## 8 — First launch

```bash
cd /home/<user>/apollo-sfs

# Pull images and build containers (takes several minutes on a Pi)
docker compose build

# Start everything
docker compose up -d

# Watch logs to confirm all services are healthy
docker compose logs -f
```

The database schema is applied automatically on the first boot of `db-app` — PostgreSQL runs all files in `db/` in numeric order via the `/docker-entrypoint-initdb.d` mount. If the data volume already exists the init scripts are skipped.

Verify all containers are running:

```bash
docker compose ps
```

All services should show `healthy` or `running`.

---

## 9 — Create the first admin user

Registration is invite-only, so there is no way to sign up through the app until an admin exists. The first admin user must be created directly in the Keycloak admin console.

### 9.1 — Create the user via the Keycloak CLI

Keycloak 26 production mode enforces strict hostname rules that prevent the browser admin console from being reached via SSH tunnel. Use `kcadm.sh` instead — it runs inside the container and connects directly to the local port, bypassing all hostname redirects.

All four commands below can be run from the Pi over your normal SSH session (no tunnel needed).

**Authenticate as the bootstrap admin:**

```bash
set -a && source .env  && set +a
```

```bash
docker exec -it apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8180 \
  --realm master \
  --user "$KEYCLOAK_ADMIN" \
  --password "$KEYCLOAK_ADMIN_PASSWORD"
```

**Create the user** (replace values as appropriate):

```bash
docker exec -it apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh create users \
  -r apollo-sfs-realm \
  -s username=<your-username> \
  -s email=<your-email> \
  -s enabled=true \
  -s emailVerified=true
```

**Set a password:**

```bash
docker exec -it apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh set-password \
  -r apollo-sfs-realm \
  --username <your-username> \
  --new-password '<your-password>'
```

**Get the user's ID** (copy the `id` value from the output):

```bash
docker exec -it apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh get users \
  -r apollo-sfs-realm \
  -q username=<your-username> \
  --fields id,username
```

**Assign the admin realm role:**

```bash
docker exec -it apollo-sfs-keycloak /opt/keycloak/bin/kcadm.sh add-roles \
  -r apollo-sfs-realm \
  --uid <user-id-from-above> \
  --rolename admin
```

### 9.3 — First login and app-DB provisioning

Open `https://apollo-sfs.com` and sign in with the credentials you just set. On the first successful login the API automatically creates the user's record in the app database, generates their encryption key, and reads the `admin` role from the JWT claims. The **Users**, **Invitations**, and **Metrics** nav links should appear immediately.

> If the admin links do not appear, confirm the `admin` role is present in the JWT by checking the API logs (`docker compose logs api`). Also verify `KEYCLOAK_REALM` in `.env` matches the realm name exactly (`apollo-sfs-realm`).

### 9.7 — Invite subsequent users

Once logged in as admin, go to **Invitations** in the nav. Enter an email address and click **Invite** — a time-limited invite link will be emailed to the recipient. They follow the link to the registration page and create their account from there.

---

---

## Docker Swarm — Deploying and Redeploying

This section covers production deployments to the two-node Swarm. For local development, use the Docker Compose commands in the next section instead.

### Initial Swarm Setup (one time)

```bash
# On the manager node — initialize the swarm
docker swarm init

# On the Pi 5 — join as a worker (use the token printed by the command above)
docker swarm join --token <worker-token> <manager-ip>:2377

# Back on the manager — assign placement labels
docker node update --label-add tier=standard <manager-node-id>
docker node update --label-add tier=fast <pi5-node-id>

# Confirm labels are set
docker node ls
docker node inspect <node-id> --format '{{ .Spec.Labels }}'
```

### Private Registry Setup (one time)

Every node needs each custom service's image (`api`, `frontend`, `node-agent`) for
its own architecture. Rather than building on each node, build once on the manager
and push to a private registry that all nodes pull from. This is the scalable
workflow — adding a node requires no builds on it. **See
[docs/registry_setup.md](docs/registry_setup.md) for the full guide** (rationale,
maintenance, adding nodes, troubleshooting). The essential one-time steps:

**1. Start a persistent registry on the manager:**

```bash
docker run -d --name registry --restart=always \
  -p 5000:5000 -v /srv/registry:/var/lib/registry registry:2
curl -s http://127.0.0.1:5000/v2/_catalog    # -> {"repositories":[]}
```

The `-v` volume is required — without it a registry restart drops all images and the
next deploy can't pull.

**2. Choose a `REGISTRY` endpoint every node can reach.** The manager's static LAN IP
is simplest (an IP needs no name resolution):

```bash
export REGISTRY=192.168.1.10:5000     # manager LAN IP
```

**3. Trust the insecure (HTTP) registry on every node.** On the manager and every
worker, merge into `/etc/docker/daemon.json` (use your `REGISTRY` value), then
`sudo systemctl restart docker`:

```json
{
  "insecure-registries": ["192.168.1.10:5000"]
}
```

**4. Enable multi-arch builds on the manager** (the cluster mixes amd64 + arm64):

```bash
# QEMU emulators (re-run after reboot) — without this, arm64 builds fail with
# "exec /bin/sh: exec format error"
docker run --privileged --rm tonistiigi/binfmt --install all

# A container-driver builder on the host network that trusts the insecure registry.
# network=host avoids the buildx "no such host" push failure; the toml avoids the
# "HTTP response to HTTPS client" failure.
cat > /tmp/buildkitd.toml <<EOF
[registry."${REGISTRY}"]
  http = true
  insecure = true
EOF
docker buildx create --name apollo-builder --driver docker-container \
  --driver-opt network=host --config /tmp/buildkitd.toml --bootstrap --use
```

### Building Images

All three custom images are built on the manager and **pushed to the registry** so
every node pulls them — no per-node builds. Each build uses a unique `TAG` so Swarm
detects the change and rolls out new tasks; re-using a tag (e.g. `:latest`) leaves
the spec identical and the update is silently skipped. The short git SHA is a
reliable, low-friction choice:

```bash
export REGISTRY=192.168.1.10:5000          # manager LAN IP (same on every node)
export TAG=$(git rev-parse --short HEAD)

# API (multi-arch so any tier can schedule it) → registry
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ${REGISTRY}/apollo-sfs_api:${TAG} api/ --push

# Frontend (manager/amd64) → registry
docker buildx build --platform linux/amd64 \
  -t ${REGISTRY}/apollo-sfs_frontend:${TAG} frontend/ --push

# Node agent (amd64 + arm64 — runs on every node) → registry
docker buildx build --platform linux/amd64,linux/arm64 \
  -f api/Dockerfile.node-agent \
  -t ${REGISTRY}/apollo-sfs-node-agent:${TAG} api/ --push
```

Both `REGISTRY` and `TAG` must remain exported in your shell for the subsequent
`docker stack deploy` — the stack file substitutes them from the environment, not
from `.env`. (`REGISTRY` defaults to `apollo-sfs-1:5000` if unset.)

### Initial Stack Deployment

Every custom image is pushed to the registry first, then a normal `docker stack
deploy` lets each node pull its architecture. No per-node builds, no
`--resolve-image never`.

```bash
export REGISTRY=192.168.1.10:5000
export TAG=$(git rev-parse --short HEAD)

# Build + push every custom image to the registry
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ${REGISTRY}/apollo-sfs_api:${TAG} api/ --push
docker buildx build --platform linux/amd64 \
  -t ${REGISTRY}/apollo-sfs_frontend:${TAG} frontend/ --push
docker buildx build --platform linux/amd64,linux/arm64 \
  -f api/Dockerfile.node-agent \
  -t ${REGISTRY}/apollo-sfs-node-agent:${TAG} api/ --push

# Load .env (stack deploy does not read it automatically)
set -a && source .env && set +a

# Deploy the full stack — nodes pull the versioned images from the registry
docker stack deploy -c docker-stack.yml apollo-sfs

# Watch services come up
docker stack services apollo-sfs
docker stack ps apollo-sfs
```

### Redeploying After a Code Change

Re-build and push the changed image(s) under a **new** `TAG`, then re-run the same
`docker stack deploy`. Because the image reference changes, Swarm rolls out only the
affected services and each node pulls the new image from the registry. (Re-using a
tag is a no-op — Swarm sees no spec change.) Keep `REGISTRY` and `TAG` exported.

#### Redeploy the API

```bash
export REGISTRY=192.168.1.10:5000
export TAG=$(git rev-parse --short HEAD)
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ${REGISTRY}/apollo-sfs_api:${TAG} api/ --push
set -a && source .env && set +a
docker stack deploy -c docker-stack.yml apollo-sfs
```

#### Redeploy the Frontend

```bash
export REGISTRY=192.168.1.10:5000
export TAG=$(git rev-parse --short HEAD)
docker buildx build --platform linux/amd64 \
  -t ${REGISTRY}/apollo-sfs_frontend:${TAG} frontend/ --push
set -a && source .env && set +a
docker stack deploy -c docker-stack.yml apollo-sfs
```

#### Redeploy the Node Agent

```bash
export REGISTRY=192.168.1.10:5000
export TAG=$(git rev-parse --short HEAD)
docker buildx build --platform linux/amd64,linux/arm64 \
  -f api/Dockerfile.node-agent \
  -t ${REGISTRY}/apollo-sfs-node-agent:${TAG} api/ --push
set -a && source .env && set +a
docker stack deploy -c docker-stack.yml apollo-sfs
```

#### Redeploy Everything at Once

```bash
export REGISTRY=192.168.1.10:5000
export TAG=$(git rev-parse --short HEAD)
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ${REGISTRY}/apollo-sfs_api:${TAG} api/ --push
docker buildx build --platform linux/amd64 \
  -t ${REGISTRY}/apollo-sfs_frontend:${TAG} frontend/ --push
docker buildx build --platform linux/amd64,linux/arm64 \
  -f api/Dockerfile.node-agent \
  -t ${REGISTRY}/apollo-sfs-node-agent:${TAG} api/ --push
set -a && source .env && set +a
docker stack deploy -c docker-stack.yml apollo-sfs
```

`docker stack deploy` compares each service's spec against what's currently running. Because `TAG` changes with each build, Swarm detects the new image reference and rolls out only the affected services — Keycloak, MinIO, and other unchanged services are left alone.

#### Redeploy Any Other Service

```bash
# General pattern (public images pulled from a registry — no --resolve-image flag needed)
docker service update --image <image>:<tag> apollo-sfs_<service-name>

# Examples
docker service update --image quay.io/keycloak/keycloak:26.0.7 apollo-sfs_keycloak
docker service update --image minio/minio:latest apollo-sfs_minio-standard
docker service update --image minio/minio:latest apollo-sfs_minio
```

#### Restart a Service Without an Image Change

```bash
docker service update --force apollo-sfs_api
```

Useful after changing secrets or environment variables that don't require a new image.

### Running PostgreSQL Migrations

The initial schema (`db/00_extensions.sql` through `db/32_node_disks.sql`) is applied automatically by PostgreSQL on first boot via the `docker-entrypoint-initdb.d` mount — it is **skipped on subsequent starts** once the data volume exists.

Incremental schema changes live in `db/migrations/NNN_name.sql` and must be applied manually to any existing database using the provided script:

```bash
# Apply all migrations to the docker compose db-app service
# (reads POSTGRES_APP_USER and POSTGRES_APP_DB from .env automatically)
./db/apply-migrations.sh

# Apply against a specific database instead of the docker compose service
PSQL="psql postgresql://user:pw@host/db" ./db/apply-migrations.sh
```

The script applies every file in `db/migrations/` in numeric order. All migrations use idempotent SQL (`IF NOT EXISTS`, `IF EXISTS`, `ON CONFLICT DO NOTHING`, etc.) so re-running the script against an already-migrated database is safe.

For Swarm deployments where `docker compose` is not available, pass `$PSQL` pointing at the running container:

```bash
set -a && source .env && set +a
DB_CONTAINER=$(docker ps --format '{{.Names}}' | grep db-app | head -1)
PSQL="docker exec -i $DB_CONTAINER psql -U $POSTGRES_APP_USER -d $POSTGRES_APP_DB" \
  ./db/apply-migrations.sh
```

### Monitoring the Swarm

```bash
# List all services and their replica counts
docker stack services apollo-sfs

# Show which tasks are running on which node
docker stack ps apollo-sfs

# Show only failed or pending tasks
docker stack ps apollo-sfs --filter "desired-state=running" --no-trunc

# Tail logs for a service (across all replicas)
docker service logs apollo-sfs_api --follow
docker service logs apollo-sfs_frontend --follow
docker service logs apollo-sfs_keycloak --follow
docker service logs apollo-sfs_minio --follow          # fast tier (Pi)
docker service logs apollo-sfs_minio-standard --follow # standard tier (manager)
docker service logs apollo-sfs_node-agent-standard --follow
docker service logs apollo-sfs_node-agent-fast --follow

# Inspect a specific service
docker service inspect apollo-sfs_api --pretty
```

### Rolling Back a Deployment

Swarm remembers the previous service spec and can roll back instantly:

```bash
docker service rollback apollo-sfs_api
docker service rollback apollo-sfs_frontend
```

To roll back to a specific git SHA tag (the image must still be in the registry),
set `TAG` to the old SHA and redeploy — nodes pull that version back:

```bash
export REGISTRY=192.168.1.10:5000
export TAG=<previous-git-sha>   # e.g. a663b28
set -a && source .env && set +a
docker stack deploy -c docker-stack.yml apollo-sfs
```

### Troubleshooting Failed Updates

#### "No suitable node (N nodes not available)" warning during a rolling update

Expected when using `mode: host` port bindings on a single-node placement constraint. The old task holds the host port, so Swarm briefly has no valid slot for the new task until the old one stops. The `update_config` in `docker-stack.yml` sets `order: stop-first` explicitly to avoid ambiguity, and `failure_action: rollback` so a crash auto-reverts instead of leaving the service paused.

#### "update paused due to failure or early termination of task"

The new container started but exited before becoming healthy. Diagnose with:

```bash
# Show all tasks for the service with full error messages
docker service ps apollo-sfs_api --no-trunc

# Tail the service logs to see the crash output
docker service logs apollo-sfs_api --tail 50

# Inspect a specific failed task by its ID
docker inspect <task-id>
```

Once the underlying issue is fixed, either rollback or retry:

```bash
# Rollback to the previous image
docker service rollback apollo-sfs_api

# Or retry with a fresh stack deploy after rebuilding + pushing
export REGISTRY=192.168.1.10:5000
export TAG=$(git rev-parse --short HEAD)
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ${REGISTRY}/apollo-sfs_api:${TAG} api/ --push
set -a && source .env && set +a
docker stack deploy -c docker-stack.yml apollo-sfs
```

### Tearing Down the Stack

```bash
# Remove all services (data volumes are preserved)
docker stack rm apollo-sfs
```

---

## Day-2 Operations (Development / Single-Node)

These commands apply to the local development environment (`docker-compose.yml`). For production, use the Docker Swarm commands above.

### View logs

```bash
docker compose logs -f api
docker compose logs -f keycloak
```

### Restart a single service

```bash
docker compose restart api
```

### Pull updated images

```bash
docker compose pull && docker compose up -d
```

### Rebuild after a code change

```bash
docker compose build api frontend && docker compose up -d api frontend
```

### Stop everything

```bash
docker compose down
```

Data volumes (`docker/postgresql-app`, `docker/postgresql-keycloak`, `/minio/nvme-1/data`) are preserved when containers are stopped or removed. Pass `-v` to `docker compose down` only if you intend to wipe all data.

---

## Directory structure

```
apollo-sfs/
├── api/                  Go backend (Gin, PostgreSQL, MinIO, Keycloak)
├── db/                   SQL schema — applied once by postgres on first boot
├── frontend/             React + Vite SPA
├── keycloak/
│   └── import/           Place realm-export.json here before first boot
├── docker/
│   └── postfix/          Postfix spool directory (created on first boot)
├── nginx/
│   └── conf.d/
│       └── apollo-sfs.conf   Host nginx site config
├── docker-compose.yml
└── .env                  Secret values (never commit this file)
```
