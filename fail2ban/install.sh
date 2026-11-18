#!/usr/bin/env bash
# Installs fail2ban, the apollo-sfs nginx-api-scan jail, the ban-recorder
# script, and the Cloudflare IP refresh systemd timer.
# Run as root on the host machine from the project root:
#   sudo bash fail2ban/install.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS_DIR="/opt/apollo-sfs/scripts"

echo "==> Installing fail2ban"
apt-get update -qq
apt-get install -y fail2ban

echo "==> Copying fail2ban configs"
cp "$REPO_DIR/fail2ban/filter.d/nginx-api-scan.conf"  /etc/fail2ban/filter.d/
cp "$REPO_DIR/fail2ban/action.d/nginx-blocklist.conf" /etc/fail2ban/action.d/
cp "$REPO_DIR/fail2ban/jail.d/apollo-sfs.conf"        /etc/fail2ban/jail.d/

echo "==> Installing scripts to $SCRIPTS_DIR"
mkdir -p "$SCRIPTS_DIR"
cp "$REPO_DIR/fail2ban/scripts/record-ban.sh"   "$SCRIPTS_DIR/"
cp "$REPO_DIR/fail2ban/scripts/cf-ip-refresh.sh" "$SCRIPTS_DIR/"
chmod +x "$SCRIPTS_DIR/record-ban.sh" "$SCRIPTS_DIR/cf-ip-refresh.sh"

# record-ban.sh resolves COMPOSE_DIR relative to its own path; create a
# stable symlink so it always finds the project .env regardless of where
# the repo is checked out.
ln -sfn "$REPO_DIR" /opt/apollo-sfs/project

echo "==> Ensuring the nginx config directories exist"
mkdir -p /etc/nginx/conf.d /etc/nginx/blocklist.d
touch /etc/nginx/blocklist.d/auto-blocked.conf

# Install the repo's starter Cloudflare real-IP list only when none exists:
# the timer below keeps /etc/nginx/conf.d/cloudflare-real-ip.conf current, and
# copying the starter over it on every run would undo the latest refresh.
echo "==> Installing the nginx Cloudflare real-IP config (only if absent)"
if [ ! -f /etc/nginx/conf.d/cloudflare-real-ip.conf ]; then
    cp "$REPO_DIR/nginx/conf.d/cloudflare-real-ip.conf" /etc/nginx/conf.d/
fi

echo "==> Installing Cloudflare IP refresh systemd units"
cp "$REPO_DIR/fail2ban/systemd/cf-ip-refresh.service" /etc/systemd/system/
cp "$REPO_DIR/fail2ban/systemd/cf-ip-refresh.timer"   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cf-ip-refresh.timer

echo "==> Running initial Cloudflare IP refresh"
# Non-fatal: it reloads nginx, which may not be fully configured yet on a
# brand-new host (deploy.sh installs nginx first; the timer retries weekly).
systemctl start cf-ip-refresh.service || echo "WARNING: Cloudflare IP refresh failed — the starter list stays in place"

echo "==> Creating banned_ips table"
# A fresh database already gets it from db/23_banned_ips.sql on first start;
# this covers databases created before the table existed.
# shellcheck source=/dev/null
set -a; source "$REPO_DIR/.env"; set +a
APPDB="$(docker ps -qf "name=apollo-sfs_db-app" | head -n1)"
if [ -n "$APPDB" ]; then
    docker exec -i "$APPDB" \
        psql -U "$POSTGRES_APP_USER" -d "$POSTGRES_APP_DB" \
        < "$REPO_DIR/db/23_banned_ips.sql"
else
    echo "NOTE: apollo-sfs_db-app is not running — skipped (db/23_banned_ips.sql runs when the database is first created)"
fi

echo "==> Enabling and restarting fail2ban"
systemctl enable fail2ban
systemctl restart fail2ban

echo "==> Done. Timer and jail status:"
systemctl list-timers cf-ip-refresh.timer
fail2ban-client status nginx-api-scan
