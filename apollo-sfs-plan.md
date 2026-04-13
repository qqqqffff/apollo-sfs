# File Storage Web App — Detailed Project Plan

---

## Table of Contents
1. [Project Overview](#1-project-overview)
2. [Architecture Overview](#2-architecture-overview)
3. [Infrastructure & Deployment](#3-infrastructure--deployment)
4. [Backend — Go + Gin Gonic](#4-backend--go--gin-gonic)
5. [File Storage & Encryption — MinIO](#5-file-storage--encryption--minio)
6. [Master Key Rotation](#6-master-key-rotation)
7. [Authentication — Keycloak](#7-authentication--keycloak)
8. [Transactional Email — Maddy + SendGrid](#8-transactional-email--maddy--sendgrid)
9. [Reverse Proxy — Nginx](#9-reverse-proxy--nginx)
10. [Raspberry Pi — Hosting Considerations](#10-raspberry-pi--hosting-considerations)
11. [DNS — Cloudflare](#11-dns--cloudflare)
12. [Frontend — React](#12-frontend--react)
13. [Database Schema](#13-database-schema)
14. [API Routes](#14-api-routes)
15. [Development Phases](#15-development-phases)
16. [Security Considerations](#16-security-considerations)

---

## 1. Project Overview

A self-hosted, encrypted file storage web application. Users can register/login, upload files into a folder hierarchy, and preview common file types in-browser. Every user's files are encrypted at rest using a unique AES key generated and stored server-side. The entire backend stack runs in Docker, fronted by a host-level Nginx reverse proxy, with DNS managed via Cloudflare.

### Core Feature Set
- User registration, login, logout, and password reset — fully custom React UI (no Keycloak screens)
- Keycloak used as a pure backend auth server via the ROPC grant (server-to-server only)
- Tokens returned as `HttpOnly` cookies — never exposed to JavaScript
- Per-user AES-256 encryption at rest (server-managed keys)
- Automatic master key rotation every 30 days — old keys kept in DB during re-wrap window then purged
- Upload, download, rename, move, and delete files
- Create, rename, and delete folders (virtual directory structure)
- In-browser file previews — images (PNG, JPG, GIF, WebP) and PDFs
- Quota tracking per user with storage warning emails
- Self-hosted transactional email via **Maddy SMTP** with **SendGrid** as the outbound SMTP relay — password reset, welcome, quota warnings, file share invitations, and user invitations
- **Admin role** — designated admin accounts (Keycloak realm role) with elevated capabilities:
  - Send user invitations (invite-only registration; regular users cannot invite)
  - View all user accounts with per-user storage usage, file count, and last-seen timestamp
  - Adjust per-user storage quotas
  - View real-time server metrics: CPU usage, memory usage, per-user and total storage consumed, and network I/O (bytes in/out)

---

## 2. Architecture Overview

```
                        Internet
                           │
                    [Cloudflare DNS]           [SendGrid]
                    (yourdomain.com)           SMTP relay
                           │ HTTPS (443)            ▲
                    [Nginx — Host Level]            │ port 587
                    (TLS termination)               │ (outbound only)
                           │ HTTP (internal)        │
              ┌────────────┴────────────────────────┤
              │        Docker Network               │
              │                                     │
         [Go + Gin API] ──────────► [Keycloak]  [Maddy SMTP]
         (only service                  │         (internal :587)
          on host port)           [PostgreSQL]       │
              │                  (Keycloak DB)       │
         [MinIO]                                     │
         (local disk)        Go API + Keycloak ──────┘
              │              submit mail here
         [PostgreSQL]
         (App metadata DB)
              └────────────────────────────────────┘
```

> Keycloak is **not** exposed publicly. Only the Go API communicates with it (server-to-server ROPC calls). Maddy is the internal mail submission hub — both the Go API and Keycloak relay through it on port 587. Maddy then forwards all outbound mail to **SendGrid** via authenticated SMTP relay, bypassing the residential ISP port 25 block entirely. Nginx routes all inbound HTTP traffic exclusively to the Go API.

### Component Responsibilities

| Component | Role |
|---|---|
| **Cloudflare** | DNS resolution, DDoS protection, CDN edge |
| **Nginx (host)** | TLS termination, reverse proxy to Go API only |
| **Go + Gin** | REST API — business logic, custom auth endpoints, file ops, email dispatch |
| **MinIO** | Object storage on local disk, stores encrypted file blobs |
| **Keycloak** | Backend-only auth server — validates credentials, issues JWTs; relays mail through Maddy |
| **Maddy** | Self-hosted SMTP submission hub — accepts mail from Go API and Keycloak, relays outbound through SendGrid |
| **SendGrid** | Cloud SMTP relay — handles final delivery to recipient mail servers, bypasses ISP port 25 block |
| **PostgreSQL (app)** | File metadata, folder structure, user keys, quotas, email queue |
| **PostgreSQL (keycloak)** | Keycloak's own user/session data |
| **React SPA** | Client-side frontend served as static files via Nginx — fully custom auth UI |

---

## 3. Infrastructure & Deployment

### Docker Compose Stack

All backend services run in a single Docker Compose project on the server. Nginx runs on the host (not in Docker) to manage TLS with Let's Encrypt or Cloudflare-issued certificates.

**File: `docker-compose.yml`**

```
services:
  api           → Go + Gin REST API          (port 8080, internal)
  minio         → MinIO object storage       (port 9000, internal; 9001 console optional)
  keycloak      → Keycloak OIDC provider      (port 8180, internal)
  maddy         → Maddy SMTP server           (port 587, internal only; relays outbound via SendGrid)
  ddns          → cloudflare-ddns             (no ports; polls public IP, updates Cloudflare A record)
  db-app        → PostgreSQL for app data     (port 5432, internal)
  db-keycloak   → PostgreSQL for Keycloak     (port 5433, internal)
```

All services communicate over a private Docker bridge network (`app-network`). Only the API service port is exposed to the host (bound to `127.0.0.1`), so Nginx can proxy to it. Maddy requires outbound internet access on port **587** to relay mail through SendGrid — this is the only Docker service that needs egress, and port 587 is not blocked by residential ISPs. All other internal services (MinIO, Keycloak, both databases) are not exposed to the host or internet.

> **Raspberry Pi / residential ISP note:** Port 25 (direct SMTP delivery) is universally blocked on residential connections. By relaying through SendGrid on port 587, this is a non-issue — no port 25 access is required at all.

**Named Volumes:**
- `minio-data` → `/minio/nvme-1/data/minio`
- `db-app-data` → `/minio/nvme-1/data/postgres-app`
- `db-keycloak-data` → `/minio/nvme-1/data/postgres-keycloak`
- `keycloak-config` → Keycloak realm import files
- `maddy-data` → `/minio/nvme-1/data/maddy`

> **Raspberry Pi storage:** All named volumes must point to paths under `/minio/nvme-1/` on the NVMe drive, not the SD card. SD cards are not rated for the constant random write patterns of a database and will fail prematurely. Move the Docker data directory itself (`/var/lib/docker`) to the NVMe drive as well to capture image layers and container logs.

### Environment Variables (`.env`)
```
POSTGRES_APP_USER, POSTGRES_APP_PASSWORD, POSTGRES_APP_DB
POSTGRES_KC_USER, POSTGRES_KC_PASSWORD, POSTGRES_KC_DB
MINIO_ROOT_USER, MINIO_ROOT_PASSWORD
MINIO_BUCKET_NAME
KEYCLOAK_ADMIN, KEYCLOAK_ADMIN_PASSWORD
KEYCLOAK_REALM, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET
KEYCLOAK_INTERNAL_URL (= http://keycloak:8180 — internal Docker URL only)
KEY_ENCRYPTION_KEY (AES-256 KEK — encrypts master keys at rest in DB; never rotated; never stored in DB)
COOKIE_DOMAIN (= yourdomain.com)
COOKIE_SECURE (= true in production)
TOKEN_REFRESH_THRESHOLD (= 60 — seconds before access token expiry to trigger proactive refresh)
APP_BASE_URL
MADDY_INTERNAL_HOST (= maddy:587 — internal Docker SMTP submission endpoint)
MAIL_FROM (= noreply@yourdomain.com)
MAIL_DOMAIN (= yourdomain.com)
QUOTA_WARNING_THRESHOLD_PERCENT (= 80 — triggers quota warning email)
SENDGRID_SMTP_HOST (= smtp.sendgrid.net)
SENDGRID_SMTP_PORT (= 587)
SENDGRID_SMTP_USER (= apikey — literal string, not your email)
SENDGRID_SMTP_PASSWORD (= your SendGrid API key with Mail Send permission)
CLOUDFLARE_API_TOKEN (= scoped token for DNS record updates — used by DDNS service)
CLOUDFLARE_ZONE_ID (= your Cloudflare zone ID)
CLOUDFLARE_RECORD_NAME (= yourdomain.com — the A record to keep updated)
```

---

## 4. Backend — Go + Gin Gonic

### Project Structure

```
/api
  /cmd
    main.go                  ← Entry point
  /internal
    /config                  ← Env/config loading
    /middleware
      auth.go                ← HttpOnly cookie → JWT validation middleware
      token_refresh.go       ← Proactive token refresh middleware (runs after auth.go)
      admin.go               ← Admin role guard — checks for `admin` realm role in JWT claims; returns 403 if absent
      rate_limit.go          ← Per-IP rate limiting for auth endpoints
      logger.go
    /handlers
      ── Each file name mirrors the route group it serves ──
      auth.go                        ← POST /auth/register, /auth/login, /auth/logout, /auth/refresh, /auth/forgot-password, /auth/reset-password
      me.go                          ← GET /me
      files.go                       ← GET|POST|PATCH|DELETE /files/* (upload, download, preview, rename, move, delete)
      folders.go                     ← GET|POST|PATCH|DELETE /folders/*
      invitations.go                 ← GET /invitations/{token} (public token validation)
      health.go                      ← GET /health
      /admin
        users.go                     ← GET /admin/users, GET /admin/users/{id}, PATCH /admin/users/{id}/quota
        invitations.go               ← POST /admin/invitations, GET /admin/invitations, DELETE /admin/invitations/{id}
        metrics.go                   ← GET /admin/system/metrics
    /services
      auth_service.go        ← ROPC calls to Keycloak, cookie management
      file_service.go        ← Business logic for file ops
      folder_service.go
      encryption_service.go  ← AES key generation & en/decryption
      key_rotation_service.go ← Master key rotation scheduler & re-wrap logic
      minio_service.go       ← MinIO client wrapper
      email_service.go       ← SMTP client (connects to Maddy), template rendering, queue dispatch
      invite_service.go      ← User invitation token generation & validation (admin-only)
      metrics_service.go     ← Server metrics: CPU, memory, network I/O, storage summary
    /models
      user.go
      file.go
      folder.go
    /email
      templates/
        welcome.html           ← Welcome email template
        password_reset.html    ← Password reset email template
        quota_warning.html     ← Quota warning email template
        file_shared.html       ← File shared notification template (future)
        invitation.html        ← User invitation email template
    /db
      postgres.go            ← DB connection & migrations
      queries.go
  /migrations                ← SQL migration files
  Dockerfile
  go.mod / go.sum
```

### Middleware

**Cookie Auth Middleware (`auth.go`)**
- Reads the `access_token` from the `HttpOnly` cookie on every protected request
- Validates the JWT signature against Keycloak's JWKS endpoint (fetched from `KEYCLOAK_INTERNAL_URL` — internal Docker network only)
- Validates expiry, issuer, and audience claims
- Extracts `sub` (user ID), `preferred_username`, and token expiry (`exp` claim) from token claims
- Injects user context and token expiry into Gin context for downstream middleware
- Returns `401` if token is missing, expired, or invalid

**Proactive Token Refresh Middleware (`token_refresh.go`)**

Runs on every authenticated request, immediately after `auth.go`. Rather than waiting for the access token to expire and forcing a round-trip `401 → refresh → retry` cycle on the client, this middleware silently refreshes the token in the background when it is close to expiring — the response is served normally and the refreshed cookies are set on the same response.

Behaviour:

- Reads the `exp` claim injected by `auth.go` from the Gin context
- If the access token expires in more than `TOKEN_REFRESH_THRESHOLD` (e.g. 60 seconds) → do nothing, pass through
- If the access token expires within the threshold window:
  1. Read the `refresh_token` cookie from the request
  2. POST to Keycloak's token refresh endpoint (internal Docker URL) with the refresh token
  3. On success → set new `access_token` and `refresh_token` cookies on the outgoing response; the handler continues normally and the client transparently receives fresh cookies
  4. On failure (refresh token also expired or revoked) → do **not** abort the current request (the access token is still valid for now); set a response header `X-Token-Refresh-Failed: true` so the React client knows to prompt re-login at the next natural expiry
- The refresh call is made **synchronously** within the request lifecycle so the new cookies are set on the same HTTP response — no separate background goroutine or second request from the client is needed
- A mutex-keyed-by-user-ID prevents concurrent requests from the same user from triggering simultaneous refresh calls (only the first one refreshes; subsequent concurrent requests skip and reuse the still-valid token)

```
Request arrives
      │
  [auth.go] — validate access_token cookie
      │  inject: userID, exp into Gin context
      │
  [token_refresh.go] — check exp
      │
      ├── exp > threshold?  → pass through unchanged
      │
      └── exp ≤ threshold?
              │
          POST Keycloak refresh (server-to-server)
              │
          ┌── success → set new cookies on response, continue to handler
          └── failure → set X-Token-Refresh-Failed header, continue to handler
                              (access token still valid for remaining TTL)
      │
  [handler] — executes normally
      │
  Response sent (may include new cookies if refresh occurred)
```

Configuration:
```
TOKEN_REFRESH_THRESHOLD (= 60 — seconds before expiry at which to proactively refresh)
```

This means a user with a 5-minute access token TTL will have their token silently refreshed on the first request made after the 4-minute mark, with no interruption to their session and no extra round-trip from the browser.

**Rate Limit Middleware (`rate_limit.go`)**
- Applied only to `/api/v1/auth/*` routes
- Limits login attempts per IP (e.g. 10 requests/minute) to supplement Keycloak's built-in brute-force protection

### Auth Service (`auth_service.go`)

Handles all communication between the Go API and Keycloak. React never talks to Keycloak directly.

**Login flow:**
1. Receive `{ email, password }` from React.
2. POST to Keycloak ROPC endpoint (internal Docker URL): `grant_type=password`.
3. On success, receive `access_token` + `refresh_token` from Keycloak.
4. Set both as `HttpOnly; Secure; SameSite=Strict` cookies on the response.
5. Trigger user provisioning if first login (create DB record + generate encryption key).
6. Return `{ user: { id, username, email, storage_used, storage_quota } }` as JSON body.

**Refresh flow** (called by both `token_refresh.go` middleware and the explicit `POST /auth/refresh` endpoint):
1. Read `refresh_token` cookie from request.
2. POST to Keycloak token refresh endpoint (internal Docker URL).
3. Set new `access_token` (and `refresh_token` if rotated) cookies on response.
4. Update in-memory token expiry for concurrent request deduplication.

**Logout flow:**
1. Read `refresh_token` cookie.
2. POST to Keycloak logout endpoint to invalidate the session server-side.
3. Clear both cookies by setting them with `Max-Age=0`.

**Password reset flow:**
1. `POST /api/v1/auth/forgot-password` — React sends `{ email }`.
2. Go API calls Keycloak Admin REST API to trigger Keycloak's built-in "send reset email" action for the user.
3. Keycloak sends a password reset email (using its own configured SMTP) directly to the user.
4. User clicks the link in the email → directed to a **custom React page** (`/reset-password?token=...`).
5. React extracts the token from the URL and calls `POST /api/v1/auth/reset-password` with `{ token, new_password }`.
6. Go API calls the Keycloak Admin REST API to complete the password reset using the token.
7. User is redirected to login.

> **Note on SMTP:** Keycloak is configured to relay outbound email through **Maddy** on `maddy:587`. Maddy then forwards to **SendGrid** via authenticated SMTP relay. All outbound mail — from both Keycloak and the Go API — flows through this single pipeline: Maddy acts as the internal submission point, SendGrid handles final delivery. No port 25 access is required.

### Key Dependencies
- `github.com/gin-gonic/gin` — HTTP router
- `github.com/minio/minio-go/v7` — MinIO client
- `github.com/golang-jwt/jwt/v5` — JWT parsing & validation
- `github.com/jackc/pgx/v5` — PostgreSQL driver
- `github.com/golang-migrate/migrate/v4` — DB migrations
- `github.com/google/uuid` — UUID generation
- `golang.org/x/time/rate` — Token bucket rate limiter for auth endpoints
- `net/smtp` (stdlib) — SMTP client for connecting to Maddy submission port
- `html/template` (stdlib) — Email HTML template rendering
- `github.com/shirou/gopsutil/v3` — Cross-platform system metrics (CPU percent, virtual memory, network I/O counters) used by `metrics_service.go`

---

## 5. File Storage & Encryption — MinIO

### Storage Layout in MinIO

MinIO is configured with a single bucket (e.g. `user-files`). Objects are stored using a flat key scheme that encodes the owning user and a unique file ID:

```
user-files/
  {user_id}/{file_uuid}        ← encrypted file blob
```

The folder structure is **virtual** — it lives entirely in the PostgreSQL metadata database. MinIO only stores raw encrypted blobs, keyed by UUID.

### Per-User Encryption

**Key Generation (on first login):**
1. Generate a random 256-bit AES key for the user.
2. Load the current active master key from memory (loaded at startup from `master_keys` table, decrypted with KEK).
3. Encrypt the user key using AES-256-GCM with the active master key + a fresh random nonce.
4. Store `encrypted_key`, `key_nonce`, and `master_key_version` in the `users` table.

**File Upload Flow:**
1. API receives multipart file upload.
2. Fetch user's `encrypted_key`, `key_nonce`, and `master_key_version` from DB.
3. Load the master key for that version (active or retiring) → decrypt user key → get plaintext AES key.
3. Generate a random 96-bit nonce.
4. Encrypt file bytes using AES-256-GCM (plaintext AES key + nonce).
5. Store `nonce + ciphertext` as a single blob in MinIO.
6. Store file metadata (name, size, folder, MIME type, MinIO object key) in PostgreSQL.

**File Download Flow:**
1. Validate JWT → get user ID.
2. Fetch file metadata from DB (verify ownership).
4. Fetch encrypted blob from MinIO.
5. Decrypt blob (strip nonce prefix → AES-256-GCM with user key).
6. Stream plaintext bytes to client with correct `Content-Type` header.

**Preview Flow:**
- Same as download, but response is served inline (`Content-Disposition: inline`).
- For images: stream directly to browser.
- For PDFs: stream directly; browser renders natively.
- No server-side thumbnail generation in v1.

---

## 6. Master Key Rotation

The `ENCRYPTION_MASTER_KEY` is the root of the entire encryption hierarchy — it wraps every user's AES key stored in the database. Rotating it every 30 days limits the blast radius of a key compromise: even if an attacker obtained an old master key, only the window before rotation is exposed, and all user keys re-wrapped under the new master key are safe.

### Rotation Strategy

The chosen approach is a **graceful re-wrap with an overlap window**:

1. A new master key is generated and becomes the active encryption key.
2. The old master key is retained in the `master_keys` table with a `retired_at` timestamp and a `status` of `retiring`.
3. A background worker re-wraps every user's `encrypted_key` under the new master key, updating the `master_key_version` reference on each user row.
4. Once all user keys have been re-wrapped, the old master key's status is updated to `deleted` — its key material is zeroed and removed from the DB. Only the metadata row (version, timestamps) is kept for audit purposes.

This avoids a hard cutover where in-flight requests using the old key would fail. The overlap window is short (minutes to hours depending on user count) since re-wrapping is a fast in-memory operation with no file I/O.

### Key Versioning Model

```
master_keys table
  id (version)   status      created_at    retired_at    deleted_at
  v1             deleted     day 0         day 30        day 30 + Δ
  v2             deleted     day 30        day 60        day 60 + Δ
  v3             active      day 60        —             —

users table
  id    encrypted_key    key_nonce    master_key_version
  u1    <blob>           <nonce>      v3   ← re-wrapped to current
  u2    <blob>           <nonce>      v3
```

During the overlap window, both `v2` (retiring) and `v3` (active) are live in memory. Once all users show `master_key_version = v3`, the `v2` key material is purged.

### `master_keys` DB Table

| Column | Type | Notes |
|---|---|---|
| `id` | VARCHAR PK | e.g. `v1`, `v2`, `v3` — monotonically incrementing |
| `encrypted_key_material` | BYTEA | The master key itself, encrypted at rest using the `KEY_ENCRYPTION_KEY` (see below) |
| `key_nonce` | BYTEA | GCM nonce used to encrypt the key material |
| `status` | VARCHAR | `active`, `retiring`, `deleted` |
| `created_at` | TIMESTAMPTZ | |
| `retired_at` | TIMESTAMPTZ | Set when a new master key is activated |
| `deleted_at` | TIMESTAMPTZ | Set when key material is zeroed and purged |

### Key Encryption Key (KEK)

The master keys stored in the DB must themselves be protected at rest. This is handled by a **Key Encryption Key (KEK)** — a second AES-256 key that lives only in the environment (never in the DB) and is used solely to encrypt/decrypt master key material when reading from or writing to the `master_keys` table.

```
Environment:
  KEY_ENCRYPTION_KEY    ← never rotated, never in DB, protect this above all else

Database:
  master_keys.encrypted_key_material  ← master key, encrypted by KEK
  users.encrypted_key                 ← user AES key, encrypted by current master key
  files (MinIO)                       ← file blob, encrypted by user AES key
```

This gives a three-layer encryption hierarchy:

```
KEK (env only)
  └── Master Key (DB, encrypted by KEK)   ← rotates every 30 days
        └── User AES Key (DB, encrypted by master key)   ← re-wrapped on rotation
              └── File data (MinIO, encrypted by user AES key)
```

The KEK itself does not rotate — it is the trust anchor. Protect it like a root CA private key: back it up offline, store it in a password manager, and never commit it to version control.

### Rotation Schedule

Rotation is triggered by a **cron job inside the Go API** using a background goroutine that checks on startup and every 24 hours whether the active master key is older than 30 days. If so, it initiates the rotation sequence automatically with no manual intervention required.

### Rotation Sequence (Step by Step)

```
1. Check: is active master key older than 30 days?
   No  → sleep 24h, repeat
   Yes → begin rotation

2. Generate new 256-bit master key (crypto/rand)
3. Encrypt new master key with KEK → store in master_keys with status=active
4. Update old master key status → retiring

5. For each user (batched, e.g. 50 at a time):
   a. Read user's encrypted_key + key_nonce + master_key_version from DB
   b. Decrypt user key using the retiring master key
   c. Re-encrypt user key using the new active master key
   d. Update user row: encrypted_key, key_nonce, master_key_version = new version
   e. Brief sleep between batches to avoid DB pressure on the Pi

6. Verify: count users where master_key_version != new version → must be 0

7. Zero the retiring master key's key material in memory
8. Update retiring master key in DB: status=deleted, key_material=NULL, deleted_at=now()
9. Log rotation completion with old version, new version, user count re-wrapped, duration
```

### Env Var Changes

The single `ENCRYPTION_MASTER_KEY` env var is replaced by:

```
KEY_ENCRYPTION_KEY   ← KEK — AES-256 key, base64-encoded, never changes
```

The current active master key is now fetched from the `master_keys` DB table at startup (decrypted using the KEK) rather than read directly from the environment. This allows rotation without a server restart or env var change.

### `key_rotation_service.go`

New service added to `/internal/services/`:

- `StartRotationScheduler()` — launches background goroutine, checks every 24h
- `RotateMasterKey()` — executes the full rotation sequence above
- `LoadActiveMasterKey()` — called at startup and after rotation to load the current master key into memory
- `DecryptWithVersion(version, ciphertext, nonce)` — used during re-wrap to decrypt with any non-deleted master key version
- All rotation events written to a `key_rotation_log` table for audit trail

### `key_rotation_log` DB Table

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `old_key_version` | VARCHAR | Master key version being retired |
| `new_key_version` | VARCHAR | Master key version being activated |
| `users_rewrapped` | INT | Count of user keys re-wrapped |
| `started_at` | TIMESTAMPTZ | |
| `completed_at` | TIMESTAMPTZ | NULL if rotation failed mid-way |
| `status` | VARCHAR | `completed`, `failed` |
| `error` | TEXT | Error message if failed |

### Handling a Failed Rotation

If the rotation goroutine crashes mid-way (e.g. Pi loses power), on next startup the API detects a `retiring` master key with no corresponding `active` key newer than it. It resumes from step 5 — re-wrapping any users still on the old version — and completes the rotation. Users whose keys were already re-wrapped are skipped (idempotent check on `master_key_version`).

---

## 7. Authentication — Keycloak

### Setup

- Keycloak runs in its own Docker container with a dedicated PostgreSQL backend.
- Keycloak is **never exposed publicly** — it only listens on the internal Docker network.
- A **Realm** is created (e.g. `filestorage`) via a realm import JSON file on startup.
- A single **confidential Client** is registered for the Go API:
  - **Direct Access Grants** enabled (required for ROPC).
  - Client secret stored only in Go API env vars (`KEYCLOAK_CLIENT_SECRET`).
- SMTP is configured on the realm to relay through **Maddy** (`maddy:587`) for password reset emails. Maddy in turn relays to SendGrid for final delivery — Keycloak only needs to know about the internal Maddy address.
- Keycloak's built-in brute-force detection is enabled on the realm.
- A **`admin` realm role** is defined in the realm import. This role is manually assigned to designated admin users via the Keycloak Admin Console (internal only). The Go API reads this role from the `realm_access.roles` claim in the JWT to gate admin endpoints — no admin state is stored in the app database.

> **Assigning the admin role:** After standing up Keycloak, log in to the Admin Console at `http://localhost:8180` (from the Pi — never exposed externally), navigate to the realm → Users → select the target user → Role Mappings → assign the `admin` realm role. The next login by that user will carry the role in their JWT.

### Keycloak Admin REST API

The Go API uses the Keycloak Admin REST API (internal Docker URL) for:
- **User registration** — `POST /admin/realms/{realm}/users`
- **Triggering password reset email** — `PUT /admin/realms/{realm}/users/{id}/execute-actions-email` with action `UPDATE_PASSWORD`
- **Completing password reset** — handled automatically by Keycloak's reset link; Go API does not need to call this directly
- **Admin user listing** — `GET /admin/realms/{realm}/users` called by the admin handler to retrieve Keycloak-side user details (email, created timestamp, last login) joined with app DB metrics

The Go API authenticates to the Admin REST API using a short-lived admin token obtained via a dedicated admin service account client (or using `KEYCLOAK_ADMIN` credentials — keep this internal only).

### Registration Flow

Since Keycloak is not public, user registration is proxied through the Go API:

```
1. React sends POST /api/v1/auth/register { username, email, password }
2. Go API calls Keycloak Admin REST API to create the user
3. Go API calls Keycloak ROPC endpoint to immediately log the user in
4. Go API creates user record in app DB + generates encryption key
5. Sets HttpOnly cookies, returns user info to React
```

### Auth Flow Summary

```
React custom login form
      │ POST /api/v1/auth/login { email, password }
      ▼
Go API (server-to-server) → Keycloak ROPC token endpoint
      ▼
Keycloak validates credentials → returns access_token + refresh_token
      ▼
Go API sets HttpOnly cookies (access_token, refresh_token)
      ▼
React receives user info in JSON body — no tokens ever touch JS
      ▼
All subsequent API calls send cookies automatically (SameSite=Strict)
      ▼
Go API middleware validates access_token cookie on every request
      │
token_refresh.go checks expiry — silently refreshes if within threshold
      │
New cookies set on response transparently if refresh occurred
```

---

## 8. Transactional Email — Maddy + SendGrid

The mail stack is a two-layer design. **Maddy** runs as a Docker service and acts as the internal SMTP submission server — the single point all mail flows through from both the Go API and Keycloak. Maddy then relays every outbound message to **SendGrid** via authenticated SMTP on port 587. SendGrid handles final delivery to recipient mail servers.

This split gives you full control over email composition, templating, and queuing (self-hosted in Maddy + the app DB) while solving the fundamental problem of residential hosting: **port 25 is universally blocked by ISPs**. SendGrid is the delivery hop only — you own everything else.

### Mail Flow

```
Go API                          Maddy (internal :587)
  email_service.go  ─SMTP──►   submission (authenticated)
                                    │
Keycloak                            │  relay via STARTTLS
  realm SMTP config ─SMTP──►        │
                                    ▼
                            SendGrid SMTP relay
                            smtp.sendgrid.net:587
                                    │
                            Recipient mail server
                            (gmail.com, outlook.com, etc.)
```

### Why This Split

| Concern | Handled by |
|---|---|
| Templating & composition | Go API `email_service.go` |
| Internal submission point | Maddy (Docker, port 587, internal only) |
| Keycloak mail relay | Maddy (Keycloak only knows `maddy:587`) |
| Email queuing & retry tracking | App PostgreSQL `email_queue` table |
| Port 25 bypass (ISP block) | SendGrid SMTP relay on port 587 |
| Final delivery & deliverability | SendGrid (SPF/DKIM aligned to your domain via domain authentication) |

### SendGrid Setup

Since you already have a SendGrid subscription, setup is minimal — mainly verifying your domain if not already done and generating a scoped API key.

1. In the SendGrid dashboard, go to **Settings → Sender Authentication** and verify `yourdomain.com` as a sending domain. SendGrid will provide three CNAME records — add these in Cloudflare:

| Type | Name | Value | Purpose |
|---|---|---|---|
| `CNAME` | `em<id>.yourdomain.com` | `u<id>.wl<id>.sendgrid.net` | SPF alignment — SendGrid-generated |
| `CNAME` | `s1._domainkey.yourdomain.com` | `s1.domainkey.u<id>.wl<id>.sendgrid.net` | DKIM key 1 |
| `CNAME` | `s2._domainkey.yourdomain.com` | `s2.domainkey.u<id>.wl<id>.sendgrid.net` | DKIM key 2 |
| `TXT` | `_dmarc.yourdomain.com` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com` | DMARC policy |

> The exact CNAME values are generated per-account by SendGrid — copy them directly from the Sender Authentication dashboard. If your domain is already verified in SendGrid, these records are already in place and no DNS changes are needed.

2. Go to **Settings → API Keys**, create a new key with **"Restricted Access"**, and enable only the **Mail Send** permission. Copy the key — it is only shown once.
3. Add to your `.env`:
   - `SENDGRID_SMTP_USER=apikey` (literal string — always `apikey`, not your email or account name)
   - `SENDGRID_SMTP_PASSWORD=<your API key>`

> **No PTR record needed:** Because SendGrid delivers on your behalf, deliverability depends on SendGrid's infrastructure reputation, not your Pi's IP. No PTR record, static IP, or port 25 access is required.

### Maddy Configuration Highlights (`maddy.conf`)

- **Submission port**: `587` with STARTTLS — internal Docker only, not exposed to host
- **Relay target**: `smtp.sendgrid.net:587` with username `apikey` and `SENDGRID_SMTP_PASSWORD` (the SendGrid API key)
- **Queue**: Maddy maintains a persistent on-disk queue at `maddy-data` volume — failed SendGrid submissions are retried automatically with exponential backoff
- **No direct delivery**: Maddy does **not** attempt to deliver to recipient MX servers directly — it always relays through SendGrid. This is configured via Maddy's `relay` directive pointed at SendGrid.

### Transactional Email Types

All emails are composed and dispatched by the Go API's `email_service.go` using HTML templates, except for password reset which is triggered via the Keycloak Admin API and relayed through Maddy → SendGrid.

| Email Type | Trigger | Composed by |
|---|---|---|
| **Welcome** | User completes registration | Go API |
| **Password reset** | `POST /auth/forgot-password` | Keycloak → Maddy → SendGrid |
| **Quota warning (80%)** | Storage crosses warning threshold on upload | Go API |
| **Quota warning (100%)** | Storage quota fully reached | Go API |
| **File shared** | User shares a file *(future feature)* | Go API |
| **User invitation** | Admin or user invites someone by email | Go API |

### Email Queue Strategy

The Go API dispatches email **asynchronously** to avoid blocking API responses on mail delivery:

1. On trigger event (e.g. registration), Go API inserts a row into the `email_queue` table with status `pending`.
2. A background goroutine polls the queue every 30 seconds.
3. For each `pending` row, it renders the HTML template, connects to Maddy on `maddy:587`, and submits the message.
4. Maddy relays to SendGrid — on success, Go API marks the row `sent`. On SMTP error, it increments `attempts` and marks `failed` after 3 attempts.
5. Maddy's own queue handles transient SendGrid connectivity failures with automatic retry.

### `email_service.go` Responsibilities

- Maintains a `net/smtp` connection to `MADDY_INTERNAL_HOST` (`maddy:587`) — Maddy relays onward to SendGrid
- Renders `html/template` files from `/internal/email/templates/`
- Provides typed methods: `SendWelcome(user)`, `SendQuotaWarning(user, pct)`, `SendInvitation(email, token)`, `SendFileShared(user, file)` *(future)*
- Enqueues all sends to the `email_queue` table rather than sending synchronously

---

## 9. Reverse Proxy — Nginx

Nginx runs on the **host machine** (not in Docker). It handles:
- TLS termination using a Cloudflare Origin Certificate.
- Routing all HTTPS traffic to the Go API container only.
- Serving the React build as static files.
- Keycloak is **not proxied** — it is internal only.

### Nginx Site Config Sketch

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /etc/ssl/cloudflare/origin.crt;
    ssl_certificate_key /etc/ssl/cloudflare/origin.key;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Serve React SPA (static build output)
    root /var/www/filestorage/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;  # client-side routing fallback
    }

    # Proxy all API calls to Go container
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 500M;  # adjust for max upload size

        # Auth endpoints: tighter rate limiting
        location /api/v1/auth/ {
            limit_req zone=auth_limit burst=10 nodelay;
            proxy_pass http://127.0.0.1:8080;
        }
    }
}

# Rate limiting zone (define in http block)
# limit_req_zone $binary_remote_addr zone=auth_limit:10m rate=10r/m;

# Redirect HTTP → HTTPS
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}
```

---

## 10. Raspberry Pi — Hosting Considerations

This section covers Pi-specific concerns that affect how the rest of the plan is configured.

### Hardware Requirements

| Component | Minimum | Recommended |
|---|---|---|
| **Model** | Pi 4 (4GB RAM) | Pi 5 (8GB RAM) |
| **Storage (OS)** | High-endurance SD card | High-endurance SD card |
| **Storage (data)** | NVMe SSD via HAT module (mounted at `/minio/nvme-1`) | NVMe SSD, 500GB+ |
| **Cooling** | Passive heatsink | Active fan case |
| **Power** | Official Pi PSU | Official Pi PSU + UPS |

> **NVMe HAT expansion:** The four-slot NVMe HAT currently has one drive mounted at `/minio/nvme-1`. The remaining three slots are reserved for future expansion. When additional drives are added, the plan is to configure software RAID (mdadm) for redundancy — this is documented in the plan but not implemented at initial setup. Ensure the mount point naming convention (`/minio/nvme-1`, `/minio/nvme-2`, etc.) is consistent from the start to make future RAID migration straightforward.

> **Pi 3 / 2GB models are not recommended.** Keycloak's JVM alone idles at 512MB–900MB. With the full stack running, you will hit RAM pressure immediately on anything below 4GB.

### RAM Budget (Approximate Idle)

| Service | Approx. RAM |
|---|---|
| Keycloak (JVM) | 512–900 MB |
| PostgreSQL × 2 | 100–200 MB |
| MinIO | 150–300 MB |
| Maddy | 30–60 MB |
| Go API | 20–50 MB |
| OS + Docker overhead | 300–500 MB |
| **Total** | **~1.1–2 GB** |

Add `JAVA_OPTS=-Xms256m -Xmx512m` to the Keycloak service in `docker-compose.yml` to cap its JVM heap and prevent it from ballooning on a memory-constrained system.

### ARM64 Image Compatibility

All Docker images must have ARM64 builds. Verified support:

| Service | ARM64 Support |
|---|---|
| Go API | ✅ Self-compiled — no issue |
| PostgreSQL | ✅ Official multi-arch image |
| MinIO | ✅ Official ARM64 image |
| Maddy | ✅ Official ARM64 image |
| cloudflare-ddns | ✅ `favonia/cloudflare-ddns` is multi-arch |
| Keycloak | ⚠️ Supported from v20+, but pin to a specific version and test early |

### Storage: SD Card vs NVMe

SD cards fail under sustained random writes (databases, Docker layers, logs). All persistent data must live on the NVMe drive, currently mounted at `/minio/nvme-1`:

```
/minio/nvme-1/
  data/
    minio/            ← MinIO object storage
    postgres-app/     ← App PostgreSQL data
    postgres-keycloak/ ← Keycloak PostgreSQL data
    maddy/            ← Maddy queue and state
  docker/             ← Move /var/lib/docker here
  backups/            ← Local backup staging before off-device sync
```

To move Docker's data directory to the SSD, set `"data-root": "/minio/nvme-1/docker"` in `/etc/docker/daemon.json` before starting any containers.

Use a **high-endurance SD card** for the OS (Samsung Pro Endurance or SanDisk MAX Endurance) and configure Docker's log driver to cap log file size:

```json
// /etc/docker/daemon.json
{
  "data-root": "/minio/nvme-1/docker",
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
```

### Dynamic IP & DDNS

Home internet connections have dynamic public IPs. The `cloudflare-ddns` Docker service (using `favonia/cloudflare-ddns`) polls your public IP every 5 minutes and updates your Cloudflare A record automatically if it changes. It uses a scoped Cloudflare API token (`CLOUDFLARE_API_TOKEN`) that only has permission to edit DNS records for your zone — no other Cloudflare access.

This replaces any need for a static IP from your ISP.

### Port Forwarding

Forward ports **80** and **443** from your router to the Pi's local IP. Configure the Pi with a **static local IP** via your router's DHCP reservation (preferred) or a static config in `/etc/dhcpcd.conf`. This ensures the port forwarding doesn't break if the Pi reboots.

If your ISP blocks inbound ports 80/443, use **Cloudflare Tunnel** (`cloudflared tunnel`) instead — it creates an outbound tunnel to Cloudflare's edge so no open inbound ports are needed at all.

### Power & Reliability

- Use a **UPS** (uninterruptible power supply) for the Pi and router. An unexpected power cut mid-write can corrupt PostgreSQL's data directory.
- Ensure PostgreSQL `fsync` is **on** (it is by default — never disable it).
- Keep the Pi in a ventilated space. Under sustained upload/encryption load, a Pi 4 without active cooling will thermally throttle and slow significantly.

### Off-Device Backups

Backing up to the same Pi is useless if the hardware fails. Use `rclone` on a cron schedule to sync encrypted backups off-device:

- **Cloudflare R2** (recommended) — S3-compatible, generous free tier (10GB free), integrates naturally with your existing Cloudflare setup
- **Backblaze B2** — very cheap ($0.006/GB/month), well-supported by `rclone`

Backup targets: PostgreSQL `pg_dump` output, MinIO data directory snapshot, Keycloak realm export, and the `.env` file (encrypted separately).

---

## 11. DNS — Cloudflare

### Setup Steps

1. Add your domain to Cloudflare and point nameservers.
2. Create an **A record**: `yourdomain.com` → your server's public IP.
3. Set the proxy status to **Proxied** (orange cloud) to benefit from Cloudflare's CDN and DDoS protection.
4. **SSL/TLS Mode**: Set to **Full (Strict)** in Cloudflare dashboard.
   - This means Cloudflare ↔ origin (your server) is also encrypted.
   - Use a **Cloudflare Origin Certificate** on Nginx (free, 15-year cert from Cloudflare).
5. Enable **"Always Use HTTPS"** in Cloudflare SSL settings.
6. (Optional) Add a **Page Rule** or **Cache Rule** to bypass cache for `/api/*` and `/auth/*`.
7. Ensure `mail.yourdomain.com` A record is set to **DNS only** (grey cloud) — SMTP cannot be proxied through Cloudflare.

### Certificate Strategy
- **Cloudflare Origin Certificate** (recommended): Generated in Cloudflare dashboard, installed in Nginx. Only trusted by Cloudflare — perfect for Full (Strict) mode.
- **Alternatively**: Use Let's Encrypt with Certbot + Cloudflare DNS plugin for auto-renewal.

---

## 12. Frontend — React

### Tech Stack
- **React** (Vite build tool)
- **TanStack Router** (`@tanstack/react-router`) — file-based client-side routing with full TypeScript type safety; routes defined by file structure under `/src/routes/`
- **TanStack Query** (`@tanstack/react-query`) — server state, caching, loading states
- **Axios** — HTTP client with `withCredentials: true` (sends cookies automatically)
- **Tailwind CSS** — utility-first styling

> `react-oidc-context` and PKCE libraries are **not needed** — all auth is handled by the Go API and cookies.

### TanStack Router Setup

TanStack Router uses the **`@tanstack/router-vite-plugin`** to watch the `/src/routes/` directory and auto-generate `src/routeTree.gen.ts`. Routes are registered by file name convention — never edit `routeTree.gen.ts` by hand.

| Convention | Meaning |
|---|---|
| `__root.tsx` | Root layout wrapping the entire app |
| `index.tsx` | Index route for the current segment (`/`) |
| `_name.tsx` | Pathless layout route (no URL segment); wraps child routes |
| `_name.child.tsx` | Child of a pathless layout (`_name`) |
| `$param.tsx` | Dynamic segment (e.g. `$folderId`) |
| `name/` | Directory creates a nested route segment |

Route components use `createFileRoute('/<path>')` (or `createRootRoute()` for `__root.tsx`). Authentication guards live inside the `_auth.tsx` pathless layout — it checks `AuthContext.isAdmin` or session state and redirects to `/login` if the session is invalid.

### File Structure

```
/src
  /routes
    ── File names mirror URL structure; TanStack Router generates routeTree.gen.ts ──
    __root.tsx                  ← Root layout: global providers, nav shell
    index.tsx                   ← / → redirect to /files if authenticated, else /login
    login.tsx                   ← /login
    register.tsx                ← /register (reads ?invite= token from search params)
    forgot-password.tsx         ← /forgot-password
    reset-password.tsx          ← /reset-password (reads ?token= from search params)
    _auth.tsx                   ← Pathless authenticated layout — validates session, redirects to /login if not
    _auth.files.tsx             ← /files — root folder view (index of user's files)
    _auth.files.$folderId.tsx   ← /files/$folderId — subfolder view
    _auth.admin.tsx             ← /admin — admin dashboard; beforeLoad checks isAdmin, redirects to / if false
  routeTree.gen.ts              ← Auto-generated by @tanstack/router-vite-plugin — do not edit
  /components
    FileList.tsx                ← Table/grid of files and folders
    FileItem.tsx                ← Single file row with actions
    FolderItem.tsx              ← Single folder row with actions
    UploadButton.tsx            ← Drag-and-drop + click to upload
    UploadProgress.tsx          ← Upload progress indicator
    Breadcrumb.tsx              ← Folder navigation trail
    PreviewModal.tsx            ← Image / PDF inline preview
    ContextMenu.tsx             ← Right-click actions (rename, move, delete)
    CreateFolderModal.tsx
    RenameModal.tsx
    /admin
      UserTable.tsx             ← Paginated table of all users: email, storage used, file count, last seen
      UserDetailModal.tsx       ← Expanded user info + quota editor (PATCH /admin/users/{id}/quota)
      InviteForm.tsx            ← Email input + "Send Invite" button (POST /admin/invitations)
      InvitationList.tsx        ← Table of pending/accepted invitations with revoke action
      ServerMetrics.tsx         ← Live server stats: CPU %, RAM used/total, storage used/total, network in/out
  /hooks
    useAuth.ts                  ← Login, logout, register, refresh mutations
    useFiles.ts                 ← TanStack Query hooks for file operations
    useFolders.ts
    useUpload.ts                ← Multipart upload logic
    useAdmin.ts                 ← Admin queries: user list, metrics (polled every 10s), invitations
  /lib
    api.ts                      ← Axios instance (withCredentials: true) + 401 interceptor
  /types
    index.ts                    ← Shared TypeScript types
  /context
    AuthContext.tsx              ← Current user state (populated from /api/v1/me on load); exposes isAdmin flag derived from user role
```

### Admin Role in React

- `GET /api/v1/me` response includes an `is_admin: bool` field (derived server-side from the JWT `realm_access.roles` claim).
- `AuthContext` exposes `isAdmin` — used to conditionally render the admin nav link.
- `_auth.admin.tsx` uses TanStack Router's `beforeLoad` hook to check `isAdmin`; if false it throws a `redirect({ to: '/' })` — the guard runs before the component renders so no flash of admin UI is possible.
- The server enforces the role independently via the admin middleware — the client check is UX only.
- `ServerMetrics.tsx` polls `GET /api/v1/admin/system/metrics` every 10 seconds using TanStack Query's `refetchInterval` to display live CPU, memory, storage, and network figures.

### Auth in React

- On app load, React calls `GET /api/v1/me` — if the `access_token` cookie is valid, returns the current user; if not, returns `401`.
- On `401` from `/me` → React calls `POST /api/v1/auth/refresh` (sends `refresh_token` cookie) → if successful, retries `/me`.
- If refresh also fails → redirect to `/login`.
- Axios is configured with `withCredentials: true` globally — cookies are sent automatically on every request.
- A response interceptor catches `401`s on any protected call and attempts a silent refresh before retrying once. In practice, proactive server-side refresh (via `token_refresh.go`) means `401`s during normal usage are rare — they only occur when the refresh token itself has expired (i.e. the user has been idle for a long time).
- React checks for the `X-Token-Refresh-Failed: true` response header on any API response. If present, it queues a soft re-login prompt (e.g. a modal) to appear when the current access token fully expires rather than interrupting the user immediately.
- **No tokens are ever stored in JavaScript memory or localStorage.** All token handling is cookie-based.

### Password Reset Flow (React side)

```
1. User visits /forgot-password, enters email
2. React calls POST /api/v1/auth/forgot-password { email }
3. API responds 200 (always — to prevent email enumeration)
4. User receives email from Keycloak with a reset link pointing to:
   https://yourdomain.com/reset-password?token=<keycloak_reset_token>
5. React's ResetPasswordPage reads the token from the URL query string
6. User enters and confirms new password
7. React calls POST /api/v1/auth/reset-password { token, new_password }
8. On success → redirect to /login with a success message
```

### File Preview

- **Images**: Fetch `/api/v1/files/{id}/download` (streams decrypted bytes), render as `<img src={objectURL}>` using a blob URL.
- **PDFs**: Same download stream, render using `<iframe src={objectURL}>` or an embedded `<object>` tag. Native browser PDF rendering, no external library needed.
- Non-previewable files show a download-only prompt.

---

## 13. Database Schema

### `users`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | Matches Keycloak `sub` |
| `username` | VARCHAR | From Keycloak token |
| `email` | VARCHAR | From Keycloak token |
| `encrypted_key` | BYTEA | User's AES key, wrapped by current master key |
| `key_nonce` | BYTEA | GCM nonce used to wrap key |
| `master_key_version` | VARCHAR | FK → master_keys.id — which master key wraps this user's key |
| `storage_used_bytes` | BIGINT | Running total |
| `storage_quota_bytes` | BIGINT | Default e.g. 10GB; admin-adjustable |
| `last_seen_at` | TIMESTAMPTZ | Updated on every authenticated request (set by auth middleware) — used for admin user metrics |
| `created_at` | TIMESTAMPTZ | |

> **Admin role is not stored in the app DB.** The `admin` Keycloak realm role is the single source of truth. The Go API reads `realm_access.roles` from the validated JWT on every request — no `is_admin` column is needed here.

### `master_keys`
| Column | Type | Notes |
|---|---|---|
| `id` | VARCHAR PK | Version string e.g. `v1`, `v2` |
| `encrypted_key_material` | BYTEA | Master key encrypted by KEK; NULL after deletion |
| `key_nonce` | BYTEA | GCM nonce for KEK encryption; NULL after deletion |
| `status` | VARCHAR | `active`, `retiring`, `deleted` |
| `created_at` | TIMESTAMPTZ | |
| `retired_at` | TIMESTAMPTZ | Set when superseded by a new active key |
| `deleted_at` | TIMESTAMPTZ | Set when key material is purged |

### `key_rotation_log`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `old_key_version` | VARCHAR | Master key version being retired |
| `new_key_version` | VARCHAR | Master key version being activated |
| `users_rewrapped` | INT | Count of user keys re-wrapped |
| `started_at` | TIMESTAMPTZ | |
| `completed_at` | TIMESTAMPTZ | NULL if rotation failed mid-way |
| `status` | VARCHAR | `completed`, `failed` |
| `error` | TEXT | Error message if failed |

### `folders`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK → users | Owner |
| `parent_id` | UUID FK → folders | NULL = root folder |
| `name` | VARCHAR | |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

> Unique constraint on `(user_id, parent_id, name)` to prevent duplicate names within a folder.

### `files`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK → users | Owner |
| `folder_id` | UUID FK → folders | |
| `name` | VARCHAR | Display name |
| `mime_type` | VARCHAR | e.g. `image/png`, `application/pdf` |
| `size_bytes` | BIGINT | Original (plaintext) file size |
| `minio_object_key` | VARCHAR | e.g. `{user_id}/{file_uuid}` |
| `nonce` | BYTEA | AES-GCM nonce for this file |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

> Unique constraint on `(user_id, folder_id, name)`.

### `email_queue`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `to_address` | VARCHAR | Recipient email |
| `subject` | VARCHAR | Email subject line |
| `template_name` | VARCHAR | e.g. `welcome`, `quota_warning`, `invitation` |
| `template_data` | JSONB | Data payload passed to template renderer |
| `status` | VARCHAR | `pending`, `sent`, `failed` |
| `attempts` | INT | Number of send attempts (max 3) |
| `last_error` | TEXT | Last SMTP error message if failed |
| `created_at` | TIMESTAMPTZ | |
| `sent_at` | TIMESTAMPTZ | NULL until successfully delivered |

### `invitations`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `invited_by_user_id` | UUID FK → users | Admin user who sent the invite |
| `email` | VARCHAR | Invitee email address |
| `token` | VARCHAR | Secure random token (in invitation link) |
| `token_expires_at` | TIMESTAMPTZ | e.g. 72 hours after creation |
| `accepted_at` | TIMESTAMPTZ | NULL until invite is used |
| `revoked_at` | TIMESTAMPTZ | NULL unless an admin explicitly revoked the pending invite |
| `created_at` | TIMESTAMPTZ | |

> Unique constraint on `email` where `accepted_at IS NULL` and `revoked_at IS NULL` — prevents duplicate pending invites to the same address. Only admin-role users can insert rows here (enforced by the admin middleware on the route).

---

## 14. API Routes

All routes prefixed with `/api/v1`. Auth routes are unauthenticated (they establish the session). All other routes require a valid `access_token` cookie.

### Auth

| Method | Path | Auth required | Description |
|---|---|---|---|
| `POST` | `/api/v1/auth/register` | No | Create account `{ username, email, password }` → sets cookies |
| `POST` | `/api/v1/auth/login` | No | `{ email, password }` → validates via Keycloak ROPC → sets HttpOnly cookies |
| `POST` | `/api/v1/auth/logout` | Yes | Invalidates Keycloak session → clears cookies |
| `POST` | `/api/v1/auth/refresh` | No (uses refresh cookie) | Issues new access token → rotates cookies |
| `POST` | `/api/v1/auth/forgot-password` | No | `{ email }` → triggers Keycloak reset email (always returns 200) |
| `POST` | `/api/v1/auth/reset-password` | No | `{ token, new_password }` → completes password reset via Keycloak Admin API |

### User

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/me` | Get current user info + quota (used on app load to check session) |

### Folders

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/folders` | List root folder contents |
| `GET` | `/api/v1/folders/{folder_id}` | List folder contents (files + subfolders) |
| `POST` | `/api/v1/folders` | Create a new folder |
| `PATCH` | `/api/v1/folders/{folder_id}` | Rename a folder |
| `DELETE` | `/api/v1/folders/{folder_id}` | Delete folder (must be empty, or cascade) |

### Files

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/files/upload` | Upload a file (multipart/form-data, includes `folder_id`) |
| `GET` | `/api/v1/files/{file_id}` | Get file metadata |
| `GET` | `/api/v1/files/{file_id}/download` | Download (decrypt + stream) file |
| `GET` | `/api/v1/files/{file_id}/preview` | Preview (inline, decrypt + stream) |
| `PATCH` | `/api/v1/files/{file_id}` | Rename or move file (update `name` or `folder_id`) |
| `DELETE` | `/api/v1/files/{file_id}` | Delete file (MinIO + metadata) |

### Invitations (public — token validation only)

| Method | Path | Auth required | Description |
|---|---|---|---|
| `GET` | `/api/v1/invitations/{token}` | No | Validate an invitation token (used by React before showing register form) |

### Admin (all routes require `admin` Keycloak realm role — enforced by admin middleware)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/admin/users` | List all users with storage used, file count, last seen, quota |
| `GET` | `/api/v1/admin/users/{user_id}` | Detailed info for a single user (storage breakdown, file count, last seen) |
| `PATCH` | `/api/v1/admin/users/{user_id}/quota` | Update a user's `storage_quota_bytes` `{ quota_bytes }` |
| `POST` | `/api/v1/admin/invitations` | Send an invitation email to a new user `{ email }` |
| `GET` | `/api/v1/admin/invitations` | List all invitations (pending, accepted, revoked) |
| `DELETE` | `/api/v1/admin/invitations/{id}` | Revoke a pending invitation (sets `revoked_at`) |
| `GET` | `/api/v1/admin/system/metrics` | Current server metrics: CPU %, memory used/total, network I/O bytes, total storage used across all users |

### System

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/health` | Health check (no auth required) |

### Request / Response Shapes (examples)

**`POST /api/v1/auth/register`**
```json
Request:  { "username": "alice", "email": "alice@example.com", "password": "..." }
Response: { "user": { "id": "...", "username": "alice", "email": "...", "storage_used_bytes": 0, "storage_quota_bytes": 10737418240 } }
// Sets: access_token (HttpOnly cookie, short TTL), refresh_token (HttpOnly cookie, longer TTL)
```

**`POST /api/v1/auth/login`**
```json
Request:  { "email": "alice@example.com", "password": "..." }
Response: { "user": { "id": "...", "username": "alice", "email": "...", "storage_used_bytes": 0, "storage_quota_bytes": 10737418240 } }
// Sets: access_token (HttpOnly cookie), refresh_token (HttpOnly cookie)
```

**`POST /api/v1/auth/forgot-password`**
```json
Request:  { "email": "alice@example.com" }
Response: { "message": "If an account with that email exists, a reset link has been sent." }
// Always 200 — prevents email enumeration
```

**`POST /api/v1/auth/reset-password`**
```json
Request:  { "token": "<keycloak_reset_token>", "new_password": "..." }
Response: { "message": "Password updated successfully." }
```

**`POST /api/v1/folders`**
```json
Request:  { "name": "Documents", "parent_id": "uuid-or-null" }
Response: { "id": "...", "name": "Documents", "parent_id": null, "created_at": "..." }
```

**`GET /api/v1/folders/{folder_id}`**
```json
Response: {
  "folder": { "id": "...", "name": "Documents", "parent_id": null },
  "subfolders": [ { "id": "...", "name": "Work", ... } ],
  "files": [ { "id": "...", "name": "report.pdf", "size_bytes": 204800, "mime_type": "application/pdf", ... } ]
}
```

**`POST /api/v1/files/upload`**
```
Content-Type: multipart/form-data
Fields: file (binary), folder_id (string UUID)
Response: { "id": "...", "name": "photo.jpg", "size_bytes": 512000, "mime_type": "image/jpeg", ... }
```

**`GET /api/v1/admin/system/metrics`**
```json
Response: {
  "cpu_percent": 12.4,
  "memory": { "used_bytes": 1073741824, "total_bytes": 8589934592, "percent": 12.5 },
  "network": { "bytes_sent": 5368709120, "bytes_recv": 2147483648 },
  "storage": {
    "total_used_bytes": 42949672960,
    "user_count": 8
  },
  "sampled_at": "2025-01-01T12:00:00Z"
}
```

> CPU and memory figures come from `gopsutil`. Network I/O is a cumulative counter since system boot (same as `ifconfig` bytes) — the frontend can diff successive polls to compute throughput. Storage total is a `SUM(storage_used_bytes)` from the app DB, reflecting actual encrypted bytes stored in MinIO.

**`GET /api/v1/admin/users`**
```json
Response: {
  "users": [
    {
      "id": "...",
      "username": "alice",
      "email": "alice@example.com",
      "storage_used_bytes": 1073741824,
      "storage_quota_bytes": 10737418240,
      "file_count": 42,
      "last_seen_at": "2025-01-01T11:55:00Z",
      "created_at": "2024-06-01T09:00:00Z"
    }
  ],
  "total": 8
}
```

---

## 15. Development Phases

### Phase 1 — Infrastructure Setup
- [x] Flash Pi OS (64-bit), enable SSH, configure static local IP via router DHCP reservation
- [x] Verify NVMe drive is mounted at `/minio/nvme-1` and listed in `/etc/fstab` for auto-mount on boot
- [x] Create directory structure: `/minio/nvme-1/data/`, `/minio/nvme-1/docker/`, `/minio/nvme-1/backups/`
- [ ] Move Docker data directory to NVMe — set `data-root: /minio/nvme-1/docker` in `/etc/docker/daemon.json`
- [ ] Install Docker, Docker Compose, Nginx on host
- [ ] Configure UFW firewall: allow inbound 80, 443; no inbound port 25 needed
- [ ] Register domain, set up Cloudflare DNS + Origin Certificate
- [ ] In SendGrid, verify sending domain under Sender Authentication (if not already done) and add the provided CNAME records in Cloudflare
- [ ] Generate a SendGrid API key with Mail Send permission only; store in `.env` as `SENDGRID_SMTP_PASSWORD`
- [ ] Configure Nginx (HTTPS, HTTP→HTTPS redirect, placeholder upstream)
- [ ] Write `docker-compose.yml` with all services + health checks
- [ ] Configure Keycloak realm via realm import JSON:
  - [ ] Create realm, configure confidential client with Direct Access Grants enabled
  - [ ] Configure realm SMTP to relay through `maddy:587`
  - [ ] Enable brute-force detection
- [ ] Verify Go API can reach Keycloak on internal Docker network
- [ ] Add Maddy service to `docker-compose.yml`, configure `maddy.conf` to relay outbound via `smtp.sendgrid.net:587` using `apikey` + SendGrid API key
- [ ] Add `cloudflare-ddns` service to `docker-compose.yml` with `CLOUDFLARE_API_TOKEN`, zone ID, and record name
- [ ] Configure Keycloak JVM heap limits (`JAVA_OPTS=-Xms256m -Xmx512m`) in compose
- [ ] Send test email end-to-end (Go API → Maddy → SendGrid → inbox), verify DKIM pass via mail-tester.com (SendGrid-authenticated mail should score well out of the box)

### Phase 2 — Backend Core
- [ ] Initialize Go module, project structure, Dockerfile
- [ ] Connect to PostgreSQL, write migrations, run via `golang-migrate`
- [ ] Implement cookie-based JWT validation middleware (JWKS from internal Keycloak URL)
- [ ] Implement proactive token refresh middleware (`token_refresh.go`) with configurable threshold and concurrent refresh deduplication
- [ ] Implement `POST /auth/register` — Keycloak Admin API user creation + auto-login
- [ ] Implement `POST /auth/login` — ROPC token exchange → HttpOnly cookie response
- [ ] Implement `POST /auth/logout` — Keycloak session invalidation + cookie clearing
- [ ] Implement `POST /auth/refresh` — refresh token rotation via Keycloak
- [ ] Implement `POST /auth/forgot-password` — trigger Keycloak reset email via Admin API
- [ ] Implement `POST /auth/reset-password` — complete reset via Keycloak Admin API
- [ ] Implement user provisioning (DB record + encryption key) on first login
- [ ] Implement `key_rotation_service.go` — rotation scheduler, re-wrap logic, version tracking
- [ ] Add `master_keys` and `key_rotation_log` migrations
- [ ] Seed initial master key (v1) in DB on first startup, encrypted with KEK
- [ ] Test rotation end-to-end: trigger rotation manually, verify all users re-wrapped, verify old key material purged
- [ ] Test crash recovery: simulate mid-rotation failure, verify resume on restart
- [ ] Implement `email_service.go` — SMTP client, template renderer, queue dispatch
- [ ] Implement email queue background worker (polling goroutine)
- [ ] Implement welcome email on registration
- [ ] Implement quota warning emails (80% and 100% thresholds) triggered on upload
- [ ] Implement admin middleware (`admin.go`) — checks `realm_access.roles` JWT claim for `admin`; returns `403` if absent
- [ ] Implement `POST /admin/invitations` — generate token, insert to DB, enqueue invitation email (admin-only)
- [ ] Implement `GET /admin/invitations` — list all invitations with status
- [ ] Implement `DELETE /admin/invitations/{id}` — revoke pending invite (set `revoked_at`)
- [ ] Implement `GET /invitations/{token}` — public token validation (expiry and unused status)
- [ ] Add `last_seen_at` update to auth middleware (stamp on every authenticated request)
- [ ] Implement `metrics_service.go` using `gopsutil`: CPU percent, virtual memory, net I/O counters
- [ ] Implement `GET /admin/users` — query all users from app DB + file count via join
- [ ] Implement `GET /admin/users/{id}` — single user detail
- [ ] Implement `PATCH /admin/users/{id}/quota` — update storage quota
- [ ] Implement `GET /admin/system/metrics` — serve metrics snapshot from `metrics_service.go`
- [ ] Add `admin` realm role to Keycloak realm import JSON; assign to initial admin user after first deploy
- [ ] Integrate MinIO client, verify bucket creation
- [ ] Implement AES-256-GCM encryption/decryption service
- [ ] Implement folder CRUD endpoints
- [ ] Implement file upload + encrypt + store flow
- [ ] Implement file download + decrypt + stream flow
- [ ] Implement file/folder rename + delete
- [ ] Write integration tests for all endpoints

### Phase 3 — Frontend
- [ ] Scaffold React app with Vite + TypeScript + Tailwind; install `@tanstack/react-router`, `@tanstack/router-vite-plugin`, `@tanstack/react-query`
- [ ] Configure `@tanstack/router-vite-plugin` in `vite.config.ts` — enables file-based route auto-generation into `routeTree.gen.ts`
- [ ] Configure Axios with `withCredentials: true` + 401 refresh interceptor
- [ ] Build `AuthContext` — load current user via `GET /me` on app start; expose `isAdmin` from `is_admin` field
- [ ] Build `__root.tsx` — root layout with global providers (`QueryClientProvider`, `RouterProvider`, nav shell)
- [ ] Build `index.tsx` — redirect to `/files` if authenticated, else `/login`
- [ ] Build `_auth.tsx` pathless layout — validates session on load, redirects to `/login` if no valid session
- [ ] Build `login.tsx` — email/password form → `POST /auth/login`
- [ ] Build `register.tsx` — registration form; reads `?invite=` search param for invite token validation
- [ ] Build `forgot-password.tsx` — email form → `POST /auth/forgot-password`
- [ ] Build `reset-password.tsx` — reads `?token=` search param → `POST /auth/reset-password`
- [ ] Build `_auth.files.tsx` — root folder view (files + subfolders at root)
- [ ] Build `_auth.files.$folderId.tsx` — subfolder view using `$folderId` path param
- [ ] Add shared components: `FileList`, `FileItem`, `FolderItem`, `UploadButton`, `UploadProgress`, `Breadcrumb`, `PreviewModal`, `ContextMenu`, `CreateFolderModal`, `RenameModal`
- [ ] Add quota display to UI
- [ ] Build `_auth.admin.tsx` — uses `beforeLoad` to redirect non-admins to `/`; renders admin dashboard
- [ ] Build `UserTable` — paginated list of all users with storage, file count, last seen
- [ ] Build `UserDetailModal` — expand user details + quota editor (PATCH quota endpoint)
- [ ] Build `InviteForm` + `InvitationList` — send invites, list and revoke pending invitations
- [ ] Build `ServerMetrics` — polls `/admin/system/metrics` every 10s via TanStack Query `refetchInterval`, displays CPU %, RAM bar, storage bar, network in/out
- [ ] Add admin nav link (visible only when `isAdmin === true`)
- [ ] Build static assets, configure Nginx to serve `dist/`

### Phase 4 — Hardening & Polish
- [ ] Add Nginx rate limiting on `/api/v1/auth/` routes
- [ ] Add request size limits (`client_max_body_size` in Nginx)
- [ ] Set up log aggregation (Docker logging driver or Loki)
- [ ] Set up automated PostgreSQL backups (cron + `pg_dump` → `/minio/nvme-1/backups/`)
- [ ] Set up MinIO data backups (cron snapshot → `/minio/nvme-1/backups/`)
- [ ] Set up Keycloak realm config backup (realm export on schedule)
- [ ] Configure `rclone` to sync encrypted backups to Cloudflare R2 or Backblaze B2 (off-device)
- [ ] Enable Cloudflare bot protection + WAF rules (bypass cache for `/api/*`)
- [ ] Set up UPS — configure Pi to gracefully shut down on power loss signal if UPS supports USB communication
- [ ] Verify thermal performance under load (watch `vcgencmd measure_temp` during a large file upload)
- [ ] Test end-to-end: register → login → upload → encrypt → store → decrypt → preview → reset password

---

## 16. Security Considerations

| Area | Measure |
|---|---|
| **Key Encryption Key (KEK)** | Single trust anchor AES-256 key stored only in env (`KEY_ENCRYPTION_KEY`); never in DB or code; back up offline |
| **Master key storage** | Master keys stored in DB encrypted by KEK; key material zeroed and set to NULL after rotation window completes |
| **Key rotation** | Master key rotates automatically every 30 days; all user keys re-wrapped in batches; audit trail written to `key_rotation_log` |
| **Rotation crash safety** | Mid-rotation state is recoverable — API resumes re-wrap on next startup using `master_key_version` on each user row |
| **User key storage** | User AES keys always stored wrapped (encrypted by master key); never plaintext in DB |
| **JWT validation** | Validate signature, expiry, issuer, and audience on every request |
| **Token storage** | `access_token` and `refresh_token` stored in `HttpOnly; Secure; SameSite=Strict` cookies — never accessible to JavaScript, immune to XSS |
| **Proactive token refresh** | Server-side middleware refreshes tokens before expiry — eliminates most client-visible `401`s without exposing tokens to JavaScript; concurrent refresh deduplicated per user |
| **CSRF protection** | `SameSite=Strict` cookies prevent cross-site request forgery without needing a CSRF token |
| **HTTPS** | Enforced end-to-end: Cloudflare → Nginx (Full Strict mode with Origin Certificate) |
| **Network exposure** | Only ports 80/443 open; Keycloak and all DBs are internal Docker network only |
| **File ownership** | Every file/folder DB query filters by `user_id` from cookie-validated JWT — no IDOR possible |
| **Upload limits** | Max file size enforced in both Nginx (`client_max_body_size`) and Go handler |
| **MinIO** | Not exposed publicly; API credentials in env vars only |
| **DB credentials** | Stored in `.env`, not committed to version control (`.gitignore`) |
| **Keycloak** | Brute-force detection enabled on realm; admin credentials internal only; ROPC client secret never leaves the Go API |
| **Password reset** | Reset endpoint always returns 200 regardless of email existence — prevents user enumeration |
| **Rate limiting** | Auth endpoints rate-limited at Nginx level (10 req/min per IP) + Keycloak brute-force detection as a second layer |
| **Client secret** | `KEYCLOAK_CLIENT_SECRET` lives only in Go API env — never sent to or stored on the frontend |
| **Backups** | Encrypted backups of DB and MinIO data to a separate location |
| **DKIM/SPF/DMARC** | All outbound mail signed by Maddy; SPF and DMARC records enforce policy — reduces spoofing risk |
| **Admin role enforcement** | `admin` realm role checked server-side by `middleware/admin.go` on every admin route — reads `realm_access.roles` from the validated JWT; no client-supplied flag is trusted; returns `403` immediately if role is absent |
| **Admin role assignment** | Role assigned only via the Keycloak Admin Console (internal Docker network only, never exposed publicly) — no API endpoint can self-elevate a user to admin |
| **Admin metrics endpoint** | `GET /admin/system/metrics` returns system-level data (CPU, RAM, net I/O); gated by admin middleware so it is never accessible to regular users |
| **Invitation tokens** | Cryptographically random tokens (32 bytes), expire after 72 hours, single-use only; only admin-role users can create invites |
| **Email queue** | Emails dispatched asynchronously — API responses never block on mail delivery; failures retried up to 3 times |
| **Maddy exposure** | Maddy submission port (587) is internal Docker only — never exposed to host or internet |
| **SendGrid credentials** | `SENDGRID_SMTP_PASSWORD` (API key) stored only in `.env`; key scoped to Mail Send only — never committed to version control |
| **DDNS token** | `CLOUDFLARE_API_TOKEN` scoped to DNS edit only for your zone — minimal privilege |
| **Off-device backups** | Backups encrypted before upload to R2/B2; compromise of backup storage does not expose plaintext data |
| **SD card failure** | All critical data on NVMe at `/minio/nvme-1`; OS-only on SD card; high-endurance card used to extend lifespan |