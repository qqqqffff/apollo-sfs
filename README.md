# Apollo SFS

A self-hosted encrypted file storage service. Files are encrypted at rest with per-user AES-256-GCM keys wrapped under a rotating master key. Storage, authentication, email, and metrics run as Docker containers on a Raspberry Pi behind Cloudflare.

## Architecture

```
Internet → Cloudflare (proxy) → Host nginx (TLS termination)
                                      ├── :3000 → frontend container (React/Vite)
                                      └── :8080 → api container (Go/Gin)
                                                       ├── db-app (PostgreSQL)
                                                       ├── keycloak (OIDC/auth)
                                                       ├── minio (encrypted blobs)
                                                       └── maddy (SMTP relay)
```

nginx runs **on the host**, not in Docker. All other services run in Docker Compose on an internal bridge network.

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

# ── Email (Maddy → SendGrid) ───────────────────────────────────────────────────
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

The `maddy` service in the compose file uses `boky/postfix` — a multi-arch Postfix image that relays outbound mail through SendGrid. It is fully configured via the environment variables already set in your `.env` file (`MAIL_DOMAIN`, `SENDGRID_SMTP_PASSWORD`). No extra config file is needed.

The Go API connects to this relay at `maddy:587` (the container is named `maddy` to keep the environment variable `MADDY_INTERNAL_HOST=maddy:587` unchanged).

If you want to verify the relay is working after first launch:

```bash
docker exec -it apollo-sfs-maddy sh -c \
  "echo 'Test body' | mail -s 'Test' your@email.com"
docker compose logs maddy
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

## Day-2 operations

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
├── maddy/
│   └── maddy.conf        Maddy SMTP config (you create this)
├── nginx/
│   └── conf.d/
│       └── apollo-sfs.conf   Host nginx site config
├── docker-compose.yml
└── .env                  Secret values (never commit this file)
```
