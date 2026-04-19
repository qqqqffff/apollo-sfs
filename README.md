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

The compose file bind-mounts MinIO's data to `/minio/nvme-1/data`. Create it before the first `docker compose up`:

```bash
sudo mkdir -p /minio/nvme-1/data
sudo chown -R 1000:1000 /minio/nvme-1/data
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

Copy the site config and enable it:

```bash
sudo cp nginx/conf.d/apollo-sfs.conf /etc/nginx/sites-available/apollo-sfs
sudo ln -s /etc/nginx/sites-available/apollo-sfs /etc/nginx/sites-enabled/apollo-sfs
sudo rm -f /etc/nginx/sites-enabled/default
```

Add the rate-limit zone to `/etc/nginx/nginx.conf` inside the `http {}` block (before `include sites-enabled/*`):

```nginx
limit_req_zone $binary_remote_addr zone=auth_limit:10m rate=10r/m;
```

Test and reload:

```bash
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

## 7 — Maddy SMTP configuration

Maddy acts as a local SMTP submission hub that relays outbound mail through SendGrid.

```bash
mkdir -p maddy
cp maddy/maddy.conf.example maddy/maddy.conf   # if an example is provided
# or create maddy/maddy.conf manually — see https://maddy.email/reference/config/
```

A minimal `maddy.conf` that relays to SendGrid:

```
$(hostname) = files.example.com
$(local_domains) = $(hostname)

smtp tcp://0.0.0.0:587 {
    auth plain {
        # No auth needed — only internal Docker services submit here
        insecure_skip_auth true
    }
    deliver_to &remote_queue
}

target.remote outbound_delivery { }

queue remote_queue {
    target &outbound_delivery

    smtp_relay {
        hostname smtp.sendgrid.net
        port 587
        auth plain {
            username apikey
            password env:SENDGRID_SMTP_PASSWORD
        }
        starttls required
    }
}
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

There is no admin account seeded by default. To promote the first user:

1. Register an account through the app at `https://files.example.com`
2. Find the username (the Keycloak subject UUID printed in the API logs, or shown in the Keycloak admin console under Users)
3. Connect to the app database and set the flag:

```bash
docker exec -it apollo-sfs-postgresql-app \
  psql -U $POSTGRES_APP_USER -d $POSTGRES_APP_DB \
  -c "UPDATE users SET is_admin = true WHERE username = '<keycloak-subject-uuid>';"
```

4. Sign out and back in — the admin nav links (Users, Invitations, Metrics) will appear.

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
