# fail2ban — Automated IP Banning for Apollo SFS

Scanners and bots regularly probe the API for endpoints that do not exist.
This setup uses **fail2ban** to detect those probes in the nginx access log
and automatically block the offending IP at the nginx level. Bans are also
recorded in PostgreSQL for audit and reporting.

A companion **systemd timer** keeps the Cloudflare IP allow-list up to date
so that nginx always knows which source IPs to trust when extracting the real
client IP from the `CF-Connecting-IP` header.

---

## How it works end-to-end

### 1. Real IP extraction (nginx + Cloudflare)

All traffic arrives at nginx via Cloudflare's edge. Without extra
configuration, `$remote_addr` would be a Cloudflare infrastructure IP, not
the actual visitor. The file `nginx/conf.d/cloudflare-real-ip.conf` tells
nginx to trust Cloudflare's published CIDR ranges and extract the real client
IP from the `CF-Connecting-IP` request header:

```nginx
real_ip_header    CF-Connecting-IP;
real_ip_recursive on;
set_real_ip_from  173.245.48.0/20;
# … all Cloudflare ranges …
```

After this, every nginx variable that contains an IP — `$remote_addr`,
`$binary_remote_addr`, the access log, GeoIP, rate-limit zones — reflects the
actual visitor's IP. This is a prerequisite for everything else.

### 2. Cloudflare IP range refresh (systemd timer)

Cloudflare publishes their current edge IP ranges at:

```
https://api.cloudflare.com/client/v4/ips
```

The script `fail2ban/scripts/cf-ip-refresh.sh` fetches that endpoint,
generates a new `cloudflare-real-ip.conf`, diffs it against the live file,
and reloads nginx only if anything changed. It writes to a temp file first so
a network error or broken response never corrupts the live config.

The `cf-ip-refresh.timer` systemd unit runs this script:
- **5 minutes after every boot** (ensures the network is up before the first
  run)
- **Once a week** thereafter

`Persistent=true` means a run that was missed while the server was off will
execute immediately at next boot.

### 3. Scan detection (fail2ban filter)

fail2ban tails `/var/log/nginx/access.log` and applies the filter defined in
`fail2ban/filter.d/nginx-api-scan.conf`:

```
failregex = ^<HOST> - \S* \[.+?\] "\w+ /api/\S* HTTP/\S+" 404
```

`<HOST>` is fail2ban's built-in token that matches any IPv4 or IPv6 address
in the first field of the log line. The pattern fires when any request to an
`/api/…` route returns `404`. Legitimate users essentially never generate
repeated 404s on API routes; scanners almost always do.

### 4. Threshold and ban duration (fail2ban jail)

The jail in `fail2ban/jail.d/apollo-sfs.conf` sets the trigger conditions:

| Setting | Value | Meaning |
|---------|-------|---------|
| `maxretry` | 10 | Number of matching log lines before ban |
| `findtime` | 60 s | Time window those lines must fall within |
| `bantime` | 7 days | How long the IP stays banned |

An IP is banned after **10 requests to non-existent API routes within 60
seconds**. The 7-day ban is long enough that automated scanners rarely return.
Adjust `bantime` in `fail2ban/jail.d/apollo-sfs.conf` if needed.

### 5. Ban action (nginx blocklist + PostgreSQL)

When a ban is triggered, `fail2ban/action.d/nginx-blocklist.conf` runs three
steps in order:

**Step 1 — nginx block**
```bash
echo "deny <ip>;" >> /etc/nginx/blocklist.d/auto-blocked.conf
nginx -s reload
```
The `deny` directive is appended to the file that nginx already includes via:
```nginx
include /etc/nginx/blocklist.d/*.conf;
```
nginx is sent a `reload` signal so the new rule takes effect within seconds
without dropping existing connections.

**Step 2 — database record**
```bash
/opt/apollo-sfs/scripts/record-ban.sh "<ip>" ban "nginx-api-scan"
```
`record-ban.sh` loads credentials from the project `.env` file and runs the
following SQL inside the `apollo-sfs-postgresql-app` Docker container via
`docker exec`:

```sql
INSERT INTO banned_ips (ip, jail)
VALUES ('<ip>'::inet, 'nginx-api-scan')
ON CONFLICT (ip) DO UPDATE
    SET ban_count   = banned_ips.ban_count + 1,
        banned_at   = NOW(),
        unbanned_at = NULL,
        jail        = EXCLUDED.jail;
```

If the IP was banned before, its `ban_count` is incremented and `banned_at`
reset. If the database is unavailable, a warning is logged but the nginx ban
is unaffected — the DB write is best-effort.

**Unban** (after `bantime` expires): fail2ban removes the `deny` line using a
temp-file swap and calls `record-ban.sh … unban` which sets `unbanned_at =
NOW()` in the database.

### 6. Database schema

The `banned_ips` table is created by `db/10_banned_ips.sql`:

```sql
CREATE TABLE banned_ips (
    id          BIGSERIAL    PRIMARY KEY,
    ip          INET         NOT NULL,
    jail        TEXT         NOT NULL DEFAULT 'nginx-api-scan',
    banned_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    unbanned_at TIMESTAMPTZ,          -- NULL = currently banned
    ban_count   INT          NOT NULL DEFAULT 1
);
```

Useful queries:
```sql
-- All currently active bans
SELECT ip, jail, banned_at, ban_count
FROM   banned_ips
WHERE  unbanned_at IS NULL
ORDER  BY banned_at DESC;

-- IPs banned more than once (persistent offenders)
SELECT ip, ban_count, banned_at
FROM   banned_ips
WHERE  ban_count > 1
ORDER  BY ban_count DESC;

-- Bans in the last 24 hours
SELECT ip, jail, banned_at
FROM   banned_ips
WHERE  banned_at > NOW() - INTERVAL '24 hours'
ORDER  BY banned_at DESC;
```

---

## Installation

Run once on the server as root:

```bash
sudo bash /home/apollo/apollo-sfs/fail2ban/install.sh
```

The install script:
1. Installs fail2ban via apt
2. Copies the filter, action, and jail configs to `/etc/fail2ban/`
3. Installs `cf-ip-refresh.sh` and `record-ban.sh` to `/opt/apollo-sfs/scripts/`
4. Creates `/opt/apollo-sfs/project` as a symlink to the repo root so the
   scripts can find `.env`
5. Installs and enables the `cf-ip-refresh` systemd timer
6. Runs an immediate IP refresh and reloads nginx
7. Creates the `banned_ips` table in PostgreSQL
8. Enables and starts fail2ban

---

## Verification

```bash
# Confirm fail2ban is watching the nginx log
sudo fail2ban-client status nginx-api-scan

# Check the Cloudflare IP refresh timer
sudo systemctl list-timers cf-ip-refresh.timer

# Run the refresh manually
sudo systemctl start cf-ip-refresh.service
sudo journalctl -u cf-ip-refresh.service -n 20

# Simulate a ban (test the full pipeline)
sudo fail2ban-client set nginx-api-scan banip 1.2.3.4

# Confirm the deny rule landed in nginx
grep 1.2.3.4 /etc/nginx/blocklist.d/auto-blocked.conf

# Confirm the DB record
docker exec -i apollo-sfs-postgresql-app \
  psql -U "$POSTGRES_APP_USER" -d "$POSTGRES_APP_DB" \
  -c "SELECT * FROM banned_ips WHERE ip = '1.2.3.4';"

# Unban the test IP
sudo fail2ban-client set nginx-api-scan unbanip 1.2.3.4

# Watch ban events in real time
sudo tail -f /var/log/fail2ban.log
```

---

## Updating configs after repo changes

The config files installed by `install.sh` are **copies**, not symlinks (to
avoid fail2ban reading from a user-owned directory). After changing any file
under `fail2ban/`, re-run the relevant copy commands:

```bash
# Filter / action / jail changes
sudo cp fail2ban/filter.d/nginx-api-scan.conf  /etc/fail2ban/filter.d/
sudo cp fail2ban/action.d/nginx-blocklist.conf /etc/fail2ban/action.d/
sudo cp fail2ban/jail.d/apollo-sfs.conf        /etc/fail2ban/jail.d/
sudo systemctl restart fail2ban

# Script changes (take effect on next invocation — no restart needed)
sudo cp fail2ban/scripts/record-ban.sh    /opt/apollo-sfs/scripts/
sudo cp fail2ban/scripts/cf-ip-refresh.sh /opt/apollo-sfs/scripts/

# Systemd unit changes
sudo cp fail2ban/systemd/cf-ip-refresh.service /etc/systemd/system/
sudo cp fail2ban/systemd/cf-ip-refresh.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart cf-ip-refresh.timer
```

---

## File map

```
fail2ban/
├── README.md                       ← this file
├── install.sh                      ← one-shot setup script
├── filter.d/
│   └── nginx-api-scan.conf         → /etc/fail2ban/filter.d/
├── action.d/
│   └── nginx-blocklist.conf        → /etc/fail2ban/action.d/
├── jail.d/
│   └── apollo-sfs.conf             → /etc/fail2ban/jail.d/
├── scripts/
│   ├── cf-ip-refresh.sh            → /opt/apollo-sfs/scripts/
│   └── record-ban.sh               → /opt/apollo-sfs/scripts/
└── systemd/
    ├── cf-ip-refresh.service       → /etc/systemd/system/
    └── cf-ip-refresh.timer         → /etc/systemd/system/

nginx/
├── nginx.conf                      ← includes conf.d/cloudflare-real-ip.conf
└── conf.d/
    └── cloudflare-real-ip.conf     → /etc/nginx/conf.d/  (managed by cf-ip-refresh)

db/
└── 10_banned_ips.sql               ← banned_ips table definition
```
