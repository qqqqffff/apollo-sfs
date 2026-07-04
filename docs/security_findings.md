# Apollo SFS — Security Review Findings

**Review date:** 2026-07-04
**Scope:** Full repository — Go API (`api/`), React frontend (`frontend/`), infrastructure
(`nginx/`, `docker-stack.yml`, `fail2ban/`, `keycloak/`). Mobile app was scanned at a high level.
**Method:** Manual source review of authentication, encryption, authorization, file handling,
sharing, payments, webhooks, and deployment configuration. No dynamic testing was performed.

## How to read this document

Each finding lists a severity, the affected location, why it matters, a recommended fix, and a
**recommended Claude model** to carry out that fix. The model recommendation reflects the
complexity and blast radius of the change, not the difficulty of understanding the bug:

| Model | Use it for |
|-------|-----------|
| **Claude Haiku 4.5** | Mechanical, low-risk edits (a config line, a constant, a header). |
| **Claude Sonnet 5** | Ordinary code changes touching one or two files with clear intent. |
| **Claude Opus 4.8** | Cross-cutting changes, security-sensitive logic, or anything needing careful trade-off analysis. |
| **Claude Fable 5** | Architectural redesign of a high-blast-radius, security-critical subsystem. |

Overall the codebase is in good shape: encryption uses AES-256-GCM with per-operation random
nonces and a sound KEK → master-key → user-key → file-key hierarchy; SQL is consistently
parameterized; RLS is applied through `ForUser`; the PayPal webhook is verified server-side; the
DOCX HTML preview is run through DOMPurify; ownership checks are present on file, share, and order
endpoints. The findings below are mostly defense-in-depth and hardening items rather than
open-door vulnerabilities.

---

## Summary table

| # | Severity | Finding | Recommended model |
|---|----------|---------|-------------------|
| 1 | High | Client IP is spoofable — Gin trusts all proxies, defeating the API rate limiter, Turnstile IP binding, and abuse counters | Claude Opus 4.8 |
| 2 | Medium | Secrets injected as plaintext environment variables instead of Docker secrets | Claude Sonnet 5 |
| 3 | Medium | Long-lived presigned upload/download tokens are unrevocable bearer credentials placed in query strings | Claude Opus 4.8 |
| 4 | Medium | OIDC issuer validation disabled (`SkipIssuerCheck: true`) | Claude Sonnet 5 |
| 5 | Low | Presign HMAC secret falls back to `SESSION_KEY` (no key separation) | Claude Haiku 4.5 |
| 6 | Low | API-key argon2id hash uses a fixed empty salt | Claude Sonnet 5 |
| 7 | Low | Access-token cache entry not evicted on logout | Claude Sonnet 5 |
| 8 | Low | SendGrid inbound-webhook secret passed in the URL query string (logged) | Claude Sonnet 5 |
| 9 | Low | Postgres connections use `sslmode=disable` | Claude Haiku 4.5 |
| 10 | Info | Remote kill-switch runs host `poweroff` via `nsenter` from a privileged container with `docker.sock` | Claude Fable 5 |
| 11 | Info | CSP relies on `style-src 'unsafe-inline'` | Claude Sonnet 5 |
| 12 | Info | Weak password floor (8 chars, no complexity) on register/reset | Claude Haiku 4.5 |

---

## 1. Client IP is spoofable — rate limiting and abuse controls can be bypassed (High)

**Where:** `api/cmd/main.go` (`setupRouter`, the engine is built with `gin.New()` and never calls
`SetTrustedProxies`); consumed in `api/routes/middleware/rate_limit.go:77` (`c.ClientIP()`),
`api/routes/interest.go:51,79,109` (Turnstile `remoteip`, per-IP submission cap, stored
`IPAddress`).

**What’s wrong:** Gin defaults to trusting *all* proxies when `SetTrustedProxies` is never called.
With that default, `c.ClientIP()` reads the `X-Forwarded-For` header and, because every hop is
“trusted,” returns the left-most value — which is fully attacker-controlled. Host nginx forwards
`$proxy_add_x_forwarded_for`, so a request carrying `X-Forwarded-For: 1.2.3.4` arrives at the Go
service as `1.2.3.4, <real-client-ip>` and Gin hands back `1.2.3.4`.

**Impact:** An attacker can rotate a spoofed `X-Forwarded-For` on every request to:
- bypass the in-process API rate limiter (`APIRateLimit`, 120 req/min per IP) entirely;
- defeat the interest-form per-IP submission cap (`CountInterestSubmissionsFromIP`);
- pass an attacker-chosen `remoteip` to Cloudflare Turnstile verification;
- poison the `interest.ip_address` column and any audit/log correlation keyed on client IP.

The edge nginx `limit_req` on `/api/v1/auth/*` uses the Cloudflare-extracted real IP and is *not*
affected, so login brute-force is still throttled at the edge — but every in-process IP control is
bypassable.

**Recommended fix:** Constrain Gin’s trusted proxies to the single known hop (host nginx on
loopback) so `ClientIP()` derives from the real connecting address, not client-supplied headers:

```go
r := gin.New()
if err := r.SetTrustedProxies([]string{"127.0.0.1", "::1"}); err != nil {
    log.Fatalf("set trusted proxies: %v", err)
}
// Alternatively, since nginx already runs behind Cloudflare and sets a clean header:
// r.TrustedPlatform = "X-Real-IP"   // nginx sets X-Real-IP = $remote_addr (the real client IP)
```

Note nginx sets `X-Real-IP` to the real client IP (`$remote_addr` after Cloudflare real-IP
extraction), so `TrustedPlatform = "X-Real-IP"` is the most robust choice here. Add a test that a
forged `X-Forwarded-For` no longer changes the rate-limit bucket.

**Recommended model:** **Claude Opus 4.8** — the change is small but touches every IP-derived
security control; it needs care to pick the right header for this specific Cloudflare→nginx→Gin
chain and to verify nothing else depends on the old behavior.

---

## 2. Secrets injected as plaintext environment variables (Medium)

**Where:** `docker-stack.yml` — `environment:` blocks pass `KEY_ENCRYPTION_KEY`, `SESSION_KEY`,
`POSTGRES_APP_PASSWORD`, `POSTGRES_KC_PASSWORD`, `MINIO_ROOT_PASSWORD`, `KEYCLOAK_CLIENT_SECRET`,
`KEYCLOAK_ADMIN_PASSWORD`, `PAYPAL_CLIENT_SECRET`, `SENDGRID_SMTP_PASSWORD`,
`CLOUDFLARE_TURNSTILE_SECRET_KEY`, and `GOOGLE_WEB_OAUTH_CLIENT_SECRET` straight into containers.

**What’s wrong:** Environment variables are the weakest place to hold secrets. They are visible to
anyone who can run `docker inspect`, are readable at `/proc/<pid>/environ` by any process sharing
the namespace, are inherited by every child process (e.g. the `ffmpeg` transcode and `nsenter`
shell the API spawns), and commonly end up in crash dumps and log scrapes. `KEY_ENCRYPTION_KEY` is
the master root of the entire file-encryption hierarchy — its exposure compromises all stored
data.

**Impact:** A single low-privilege foothold on the manager node (or an over-broad monitoring
agent) can read the master encryption key, session signing key, DB and MinIO credentials without
any privilege escalation.

**Recommended fix:** Move sensitive values to Docker Swarm `secrets:` (mounted as files under
`/run/secrets/…`) and have the app read `KEY_ENCRYPTION_KEY_FILE`/`SESSION_KEY_FILE`-style
variables, or read the secret file paths directly. Swarm secrets are stored encrypted in the Raft
log and mounted in a tmpfs, not exposed via `docker inspect`. At minimum, isolate
`KEY_ENCRYPTION_KEY`.

**Recommended model:** **Claude Sonnet 5** — a well-scoped change spanning `docker-stack.yml`,
`cmd/config.go` (add `*_FILE` fallbacks), and docs; mechanical once the pattern is set.

---

## 3. Long-lived presigned tokens are unrevocable bearer credentials in query strings (Medium)

**Where:** `api/routes/files.go:759-763` (TTLs: download 1h, single upload 6h, chunked upload
**24h**), issuance/validation in `api/routes/services/presign.go`. Tokens are passed as
`?token=…` on `/files/:id/download/p`, `/files/upload/p`, `/files/upload/:id/chunk/p`, etc.

**What’s wrong:** A presigned token is a self-contained bearer credential: it embeds the user
identity and authorizes cookie-less download or upload under that account. There is no server-side
record of issued tokens, so there is no revocation and no one-time-use enforcement — a token is
valid for its full TTL no matter what. Because the token travels in the URL query string, it is
routinely captured in nginx access logs, browser history, `Referer` headers, and any proxy in
between. The 24-hour chunked-upload window is a long time for a leaked URL to be replayable to
write files into (and consume the quota of) the victim’s account.

**Impact:** Anyone who observes a presigned URL (log access, shared link, referrer leakage) can
download the target file or upload arbitrary content into the owner’s namespace until the token
expires, with no way for the owner or an admin to cut it off.

**Recommended fix:**
- Shorten TTLs sharply (download minutes, chunked upload ≤ 1h with renewal).
- Bind each token to a server-side nonce/session row so it can be revoked and, for downloads,
  optionally consumed once.
- Prefer delivering the token in an `Authorization` header or short-lived cookie rather than the
  query string; if it must stay in the URL, exclude `token` from nginx access logging.

**Recommended model:** **Claude Opus 4.8** — this reworks the presign trust model and touches
issuance, validation, the upload/download handlers, and the SFS layer that also issues these
tokens; the concurrency-safe nonce store needs careful design.

---

## 4. OIDC issuer validation disabled (Medium)

**Where:** `api/cmd/main.go:65-68` — `oidc.NewVerifier(..., &oidc.Config{ClientID: …,
SkipIssuerCheck: true})`.

**What’s wrong:** The verifier still checks the JWT signature against Keycloak’s JWKS and the
audience against the client ID, but it no longer validates the `iss` claim. The code comment
explains this is a workaround for the internal-vs-public URL mismatch (`KC_HOSTNAME` differs from
`APP_BASE_URL`). Skipping issuer validation removes a defense-in-depth layer: any token signed by
a key the JWKS endpoint serves and carrying the right audience is accepted regardless of which
realm/issuer minted it. In a multi-realm or future shared-key configuration this could allow
cross-issuer token acceptance.

**Impact:** Currently low (single realm, dedicated signing keys), but it silently weakens token
validation and would become dangerous if Keycloak’s realm/key topology changes.

**Recommended fix:** Set `KC_HOSTNAME` so Keycloak’s emitted `iss` is stable and known, then
validate it explicitly (either let go-oidc check it, or keep `SkipIssuerCheck` and add a manual
`claims.Issuer == expectedIssuer` assertion in `RequireAuth`). Document the exact expected issuer
string.

**Recommended model:** **Claude Sonnet 5** — localized change to verifier setup plus a claim
assertion and a test; needs correct understanding of the Keycloak issuer configuration.

---

## 5. Presign HMAC secret falls back to `SESSION_KEY` (Low)

**Where:** `api/cmd/config.go:163` — `PresignSecret: getEnvOrKey("PRESIGN_SECRET", "SESSION_KEY")`.

**What’s wrong:** When `PRESIGN_SECRET` is unset, presigned-token signing reuses the cookie
signing/encryption key. This breaks cryptographic key separation: the same secret now protects two
unrelated trust domains, so a leak or weakness in either context compromises both, and rotating one
forces rotation of the other.

**Recommended fix:** Require a dedicated `PRESIGN_SECRET` (fail fast if missing, like the other
`requireEnv` secrets), or derive it via HKDF from a master secret with a distinct info label rather
than reusing `SESSION_KEY` verbatim.

**Recommended model:** **Claude Haiku 4.5** — a one-line config change plus a doc/`.env.example`
note.

---

## 6. API-key argon2id hash uses a fixed empty salt (Low)

**Where:** `api/routes/services/api_key.go:276-280` — `argon2.IDKey(secret||pepper, nil, …)`.

**What’s wrong:** The hash passes `nil` as the salt. The accompanying comment argues this is safe
because the secret is 24 random bytes plus a server-side pepper, which is a defensible position for
uniformly-random secrets. The residual weaknesses are that identical secrets produce identical
hashes (so a pepper rotation is harder, and hash equality leaks secret equality), and the design
leans entirely on the pepper for salt-like entropy.

**Recommended fix:** Generate a per-key random salt, store it in the `api_keys` row alongside the
hash, and include it in `argon2.IDKey`. Keep the pepper as an additional secret. Verify remains a
constant-time compare.

**Recommended model:** **Claude Sonnet 5** — touches the service, the DB schema/migration, and the
verify path; straightforward but must preserve backward compatibility for existing keys.

---

## 7. Access-token cache entry not evicted on logout (Low)

**Where:** `api/routes/auth/logout.go` (revokes the refresh token at Keycloak and clears the
cookie) vs. `api/routes/middleware/token_cache.go` (access tokens cached keyed by refresh token).

**What’s wrong:** Logout revokes the refresh token server-side and clears the cookie, but the
in-process `accessTokenCache` entry keyed by that refresh token is left in place. The cached access
token therefore remains valid until its own (short) expiry. No new tokens can be minted (the
refresh token is revoked), so the window equals the access-token lifetime — but a stolen access
token used from another client would keep working briefly after the user “logged out.”

**Recommended fix:** On logout, call a cache-eviction method (`tokenCache.delete(refreshToken)`)
before clearing the session. Keep access-token TTLs short.

**Recommended model:** **Claude Sonnet 5** — add an eviction method to the cache and wire it into
logout; small but crosses the auth/middleware boundary.

---

## 8. SendGrid inbound-webhook secret passed in the URL query string (Low)

**Where:** `api/routes/admin/email_inbound_webhook.go:38-44` — reads `c.Query("token")` and
constant-time-compares it to `SENDGRID_WEBHOOK_SECRET`.

**What’s wrong:** The comparison is correctly constant-time, but the shared secret arrives as a URL
query parameter, so it is written verbatim into nginx access logs and any intermediary logging.
Log exposure of the secret lets an attacker forge inbound-email webhook calls.

**Recommended fix:** Accept the secret via a request header (e.g. `X-Webhook-Token`) instead of the
query string, and/or exclude the webhook path from access logging. SendGrid Inbound Parse lets you
put the secret in the configured POST URL path segment rather than a query param, or you can front
it with a header check.

**Recommended model:** **Claude Sonnet 5** — small handler change plus nginx log config and doc
update.

---

## 9. Postgres connections use `sslmode=disable` (Low)

**Where:** `api/cmd/config.go:123-130` — DSN hardcodes `sslmode=disable`.

**What’s wrong:** App-to-database traffic is unencrypted. In the current topology `api` and `db-app`
are both pinned to the manager node so traffic stays on the host, but the overlay network is
designed to span nodes and the setting removes any transport protection if that assumption changes
(and offers no authentication of the DB endpoint).

**Recommended fix:** Use `sslmode=require` (or `verify-full` with the server cert) for the app DB
connection, and configure Postgres for TLS. Make the mode configurable via env so local dev can
still use `disable`.

**Recommended model:** **Claude Haiku 4.5** — parameterize the DSN’s sslmode; the Postgres TLS
setup is ops config, not code.

---

## 10. Remote kill-switch runs host `poweroff` via `nsenter` from a privileged container (Informational — high blast radius)

**Where:** `api/routes/admin/shutdown.go` (`performSystemShutdown` — cgroup escape → `nsenter -t 1`
→ `docker compose down; poweroff`), reachable via `POST /api/v1/admin/system/shutdown`; requires
the API container to run `privileged: true`, `user: root`, and mount `/var/run/docker.sock`
(`docker-stack.yml`).

**What’s wrong:** This is an intentional operational feature, but it concentrates enormous blast
radius behind a single admin-role check. The API container runs as root, privileged, with the
Docker socket mounted (root-equivalent on the host) and the ability to enter host namespaces and
power off the machine. Any path that yields an `admin` realm role — a forged/replayed JWT (see
findings 1 and 4), an admin account compromise, or an application bug in an admin route — escalates
directly to host code execution and a denial-of-service power-off.

**Recommended fix:** Treat this as a privileged control plane, not an ordinary API route:
- Require a second, independent factor to trigger (a separately-held signing key or one-time
  operator token), not just the session’s admin role.
- Split the privileged executor into a tiny separate service with a narrow, audited interface
  instead of granting the whole API `privileged`/`docker.sock`/root.
- Ensure it is rate-limited, heavily audited, and alert-on-use.

**Recommended model:** **Claude Fable 5** — redesigning a privileged, host-controlling subsystem
with the smallest safe trust surface is exactly the kind of high-stakes, security-critical
architecture work that warrants the most capable model.

---

## 11. CSP relies on `style-src 'unsafe-inline'` (Informational)

**Where:** `nginx/conf.d/apollo-sfs.conf:57`.

**What’s wrong:** The Content-Security-Policy is otherwise tight (`default-src 'self'`,
`object-src 'none'`, `base-uri 'self'`, no `unsafe-inline` for scripts), but `style-src` allows
`'unsafe-inline'` for Tailwind/inline styles. Inline styles are a weaker XSS/exfiltration vector
than inline scripts, and the one place untrusted HTML is rendered (DOCX preview) is DOMPurify-
sanitized, so residual risk is low. Worth noting for completeness.

**Recommended fix:** Where feasible, move to hashed/nonce-based styles or a build that avoids
runtime inline styles so `'unsafe-inline'` can be dropped from `style-src`.

**Recommended model:** **Claude Sonnet 5** — requires coordinating the CSP header with the frontend
build’s style handling.

---

## 12. Weak password floor on register/reset (Informational)

**Where:** `api/routes/auth/register.go:17` (`min=8`), `api/routes/auth/reset_password.go:14`
(`min=8`).

**What’s wrong:** The application enforces only an 8-character minimum with no complexity or
breached-password check. Keycloak’s realm password policy is the real enforcement point; if it is
not configured to match, weak passwords are accepted.

**Recommended fix:** Configure a Keycloak password policy (length, complexity, and the
`notUsername`/breached-password detectors) as the authoritative control, and align the app-side
`min` with it. This is primarily a Keycloak realm configuration change.

**Recommended model:** **Claude Haiku 4.5** — small constant change plus a Keycloak realm policy
note.

---

## Things checked that looked correct

These were reviewed and did **not** yield findings, noted so the next reviewer can skip re-deriving
them:

- **Encryption** (`routes/services/encryption.go`): AES-256-GCM everywhere, fresh 12-byte random
  nonce per operation, sound KEK → master → user → file key wrapping, plaintext key material zeroed
  after use, GCM auth-tag failures surfaced as errors.
- **SQL**: consistently parameterized; the dynamic query builders in `db/orders.go` and
  `db/expansion_requests.go` build only `$N` placeholders, never interpolate user input.
- **PayPal webhook** (`routes/services/paypal.go:VerifyWebhook`): verified server-side against
  `PAYPAL_WEBHOOK_ID` before any side effect; capture/refund handlers key off verified fields.
- **Order/file/share ownership**: `CaptureOrder` checks `payment.Username`; file handlers resolve
  under `ForUser(userID)` RLS; share endpoints require the caller to be recipient or owner and never
  trust the share token alone.
- **Presign forgery**: tokens are HMAC-SHA256 signed and compared with `hmac.Equal`; identity is
  only embedded after an ownership check at issuance (the residual concern is revocation/TTL, see
  finding 3, not forgery).
- **Filename handling** (`sanitize/`): path separators and CRLF stripped from names;
  Content-Disposition filename escaped against header injection.
- **DOCX preview** (`frontend/.../FilePreviewModal.tsx`): converted HTML run through
  `DOMPurify.sanitize` before `dangerouslySetInnerHTML`.
- **Tokens at rest in the browser**: only non-sensitive UI state is kept in
  `localStorage`/`sessionStorage`; auth tokens live in the HttpOnly, Secure, SameSite=Strict session
  cookie.

## Suggested remediation order

1. Finding 1 (IP spoofing) — highest ratio of risk reduction to effort.
2. Findings 2 and 3 (secret handling, presign tokens) — meaningful data-exposure reductions.
3. Finding 4 (issuer validation), then the Low items (5–9).
4. Finding 10 (kill-switch hardening) — plan as a deliberate design change.
5. Informational items (11–12) as hardening backlog.
