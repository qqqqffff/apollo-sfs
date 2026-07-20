# Nginx & Fail2ban

Host-level nginx terminates TLS and proxies traffic to Docker services. Fail2ban watches nginx access logs and auto-bans IPs that probe for non-existent API paths.

Neither nginx nor fail2ban runs inside Docker — they run directly on the manager node (amd64 server, 8 TB HDD) so they can manage the host firewall and reload nginx without container privilege issues.

## Nginx Overview

### Configuration Files (Host)

| Path | Purpose |
|------|---------|
| `/etc/nginx/nginx.conf` | Main config: rate-limit zones, gzip, log format, include paths |
| `/etc/nginx/conf.d/apollo-sfs.conf` | HTTPS vhosts for `apollo-sfs.com`, `www.apollo-sfs.com`, and `auth.apollo-sfs.com` |
| `/etc/nginx/conf.d/cloudflare-real-ip.conf` | Extracts real client IP from `CF-Connecting-IP` header |
| `/etc/nginx/blocklist.d/auto-blocked.conf` | Auto-generated `deny <ip>;` rules written by fail2ban |
| `/etc/nginx/well-known/` | Static files for Apple Universal Links, Android App Links, and the (live) PayPal Apple Pay domain-association file |

The repository's `nginx/` directory holds the source versions of these files. Deploy them to the host with:

```bash
sudo cp nginx/nginx.conf /etc/nginx/nginx.conf
sudo cp nginx/conf.d/* /etc/nginx/conf.d/
sudo nginx -t && sudo systemctl reload nginx
```

### Domains and Proxy Targets

| Domain | Port | Proxies to |
|--------|------|-----------|
| `apollo-sfs.com` | 443 | Frontend `:3000` (static assets), API `:8080` (`/api/*`) |
| `www.apollo-sfs.com` | 443 | Not app-facing — serves `/.well-known/` directly (same files as the apex) and 301s everything else to `apollo-sfs.com`. Exists solely because payment-processor domain verification (PayPal's Apple Pay check included) probes both the apex and the `www` variant of a registered domain. DNS: CNAME to `apollo-sfs.com` (tracks the ddns-managed apex IP, no separate DDNS entry). TLS: origin cert must cover it too. |
| `auth.apollo-sfs.com` | 443 | Keycloak `:8180` |

HTTP (port 80) redirects to HTTPS for all three domains.

### TLS

- Cloudflare **Full Strict** mode — Cloudflare terminates public TLS, then re-encrypts to origin using a Cloudflare Origin Certificate.
- The origin certificate lives at `/etc/ssl/cloudflare/` on the host.
- TLS 1.2 and 1.3 only; strong cipher suite (ECDHE, ChaCha20-Poly1305).
- HSTS header: `max-age=63072000; includeSubDomains; preload` (2 years).

### Security Headers

Applied on both vhosts:

- `Content-Security-Policy` — restricts `script-src`, `style-src`, `img-src`, `connect-src`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` — disables camera, microphone, geolocation

### GeoIP Filtering

MaxMind GeoIP2 is loaded via the `ngx_http_geoip2_module`. Requests from non-US IPs receive `444 Connection Closed` with no response body. The GeoIP database must be updated periodically via `geoipupdate`.

The gate is a `map $geoip2_country_code $geo_block {...}` in `nginx.conf`, checked with `if ($geo_block) { return 444; }` inside each app-facing `location` block (`nginx.conf`'s `CLAUDE.md`-adjacent comment has the rationale) — deliberately **not** at the server level, and deliberately **not** applied to `location /.well-known/` on either `apollo-sfs.com` or `www.apollo-sfs.com`. Payment-processor and mobile-linking domain-verification crawlers (PayPal/Apple/Google) that fetch files under `/.well-known/` aren't guaranteed to call from a US IP; blocking them there would silently break Apple Pay / Universal Links verification while looking like a client-side config problem.

### Rate Limiting

Defined in `nginx.conf`:

```nginx
limit_req_zone $binary_remote_addr zone=auth_limit:10m rate=10r/m;
```

Applied to `/api/v1/auth/*` in the site config. Exceeding the limit returns `429 Too Many Requests`.

### File Upload Settings

On the `/api/*` location:

```nginx
client_max_body_size 500M;
client_body_timeout 3600s;
proxy_request_buffering off;   # stream directly to the Go API
proxy_read_timeout 3600s;
```

`proxy_request_buffering off` is critical — without it nginx would buffer the entire file body to disk before forwarding, adding latency and disk pressure on the host.

### WebSocket

The API vhost passes WebSocket upgrade headers for the metrics streaming endpoint:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### Universal / App Links

Served directly by nginx (not proxied to Docker) for mobile deep linking:

- `GET /.well-known/apple-app-site-association` → iOS Universal Links
- `GET /.well-known/assetlinks.json` → Android App Links
- `GET /.well-known/microsoft-identity-association.json` → Microsoft domain association (Azure AD app verification for the email backup Microsoft sign-in)

Source files: `/etc/nginx/well-known/` (copy from `nginx/well-known/` in this repo). Note this directory is *not* covered by the `nginx/conf.d/*` deploy step below — copy it separately:

```bash
sudo cp -r nginx/well-known/.well-known /etc/nginx/well-known/
```

---

## Fail2ban Overview

Fail2ban runs as a system service (`systemctl status fail2ban`) on the manager node alongside nginx. It watches nginx access logs and auto-bans IPs scanning for non-existent API paths.

Fail2ban is used instead of iptables blocking because all inbound connections arrive from Cloudflare edge IPs — blocking at iptables would block Cloudflare itself. Instead, bans are applied as nginx `deny` rules after real-IP extraction.

### Configuration Files

| Repository Path | Host Path | Purpose |
|----------------|-----------|---------|
| `fail2ban/filter.d/nginx-api-scan.conf` | `/etc/fail2ban/filter.d/nginx-api-scan.conf` | Regex to detect API path scanning (404s) |
| `fail2ban/jail.d/apollo-sfs.conf` | `/etc/fail2ban/jail.d/apollo-sfs.conf` | Jail: thresholds, ban time, action |
| `fail2ban/action.d/nginx-blocklist.conf` | `/etc/fail2ban/action.d/nginx-blocklist.conf` | Ban/unban actions |

Deploy to host:

```bash
sudo cp fail2ban/filter.d/* /etc/fail2ban/filter.d/
sudo cp fail2ban/jail.d/* /etc/fail2ban/jail.d/
sudo cp fail2ban/action.d/* /etc/fail2ban/action.d/
sudo systemctl reload fail2ban
```

### Filter (`nginx-api-scan.conf`)

Matches lines like:

```
"GET /api/<anything> HTTP/1.1" 404
```

Real client IP is read from nginx's `$realip_remote_addr` (set by `cloudflare-real-ip.conf` using the `CF-Connecting-IP` header).

### Jail (`apollo-sfs.conf`)

```ini
[nginx-api-scan]
enabled  = true
filter   = nginx-api-scan
logpath  = /var/log/nginx/access.log
maxretry = 10
findtime = 60
bantime  = 604800   # 7 days
action   = nginx-blocklist
```

### Action (`nginx-blocklist.conf`)

**On ban:**
1. Appends `deny <ip>;` to `/etc/nginx/blocklist.d/auto-blocked.conf`
2. Runs `nginx -s reload`
3. Calls `/opt/apollo-sfs/scripts/record-ban.sh <ip>` which inserts a row into the `banned_ips` PostgreSQL table

**On unban:**
1. Removes the `deny <ip>;` line from the blocklist file
2. Runs `nginx -s reload`

### Useful Commands

```bash
# View currently banned IPs
sudo fail2ban-client status nginx-api-scan

# Manually unban an IP
sudo fail2ban-client set nginx-api-scan unbanip <ip>

# Test a filter against the log
sudo fail2ban-regex /var/log/nginx/access.log /etc/fail2ban/filter.d/nginx-api-scan.conf

# View ban log
sudo journalctl -u fail2ban --since "1 hour ago"
```