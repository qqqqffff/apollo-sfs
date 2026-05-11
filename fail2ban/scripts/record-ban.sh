#!/usr/bin/env bash
# Records a fail2ban ban or unban event in the banned_ips PostgreSQL table.
# Called by the nginx-blocklist fail2ban action.
#
# Usage: record-ban.sh <ip> <ban|unban> [jail]
set -euo pipefail

IP="$1"
ACTION="$2"
JAIL="${3:-nginx-api-scan}"

# Load DB credentials from the project .env file.
# /opt/apollo-sfs/project is a symlink to the repo root created by install.sh.
COMPOSE_DIR="/opt/apollo-sfs/project"
# shellcheck source=/dev/null
set -a; source "$COMPOSE_DIR/.env"; set +a

run_sql() {
    docker exec -i apollo-sfs-postgresql-app \
        psql -U "$POSTGRES_APP_USER" -d "$POSTGRES_APP_DB" \
        --no-align --tuples-only -c "$1"
}

if [ "$ACTION" = "ban" ]; then
    run_sql "
        INSERT INTO banned_ips (ip, jail)
        VALUES ('${IP}'::inet, '${JAIL}')
        ON CONFLICT (ip) DO UPDATE
            SET ban_count   = banned_ips.ban_count + 1,
                banned_at   = NOW(),
                unbanned_at = NULL,
                jail        = EXCLUDED.jail;
    " || echo "record-ban: WARNING: failed to record ban for ${IP}" >&2

elif [ "$ACTION" = "unban" ]; then
    run_sql "
        UPDATE banned_ips
        SET    unbanned_at = NOW()
        WHERE  ip = '${IP}'::inet;
    " || echo "record-ban: WARNING: failed to record unban for ${IP}" >&2
fi
