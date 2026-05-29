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

echo "==> Installing Cloudflare IP refresh systemd units"
cp "$REPO_DIR/fail2ban/systemd/cf-ip-refresh.service" /etc/systemd/system/
cp "$REPO_DIR/fail2ban/systemd/cf-ip-refresh.timer"   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cf-ip-refresh.timer

echo "==> Running initial Cloudflare IP refresh"
systemctl start cf-ip-refresh.service

echo "==> Copying nginx Cloudflare real-IP config"
cp "$REPO_DIR/nginx/conf.d/cloudflare-real-ip.conf" /etc/nginx/conf.d/
nginx -t && nginx -s reload

echo "==> Ensuring auto-blocked.conf exists"
touch /etc/nginx/blocklist.d/auto-blocked.conf

echo "==> Creating banned_ips table"
# shellcheck source=/dev/null
set -a; source "$REPO_DIR/.env"; set +a
docker exec -i apollo-sfs-postgresql-app \
    psql -U "$POSTGRES_APP_USER" -d "$POSTGRES_APP_DB" \
    < "$REPO_DIR/db/10_banned_ips.sql"

echo "==> Enabling and restarting fail2ban"
systemctl enable fail2ban
systemctl restart fail2ban

echo "==> Done. Timer and jail status:"
systemctl list-timers cf-ip-refresh.timer
fail2ban-client status nginx-api-scan
