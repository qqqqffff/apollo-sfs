#!/usr/bin/env bash
#
# apply-migrations.sh — apply every db/migrations/*.sql to the running app DB.
#
# WHY THIS EXISTS
#   The base schema files (db/*.sql) are only executed by Postgres when the data
#   volume is first created (they are mounted at /docker-entrypoint-initdb.d, and
#   Postgres runs that directory exactly once, on an empty data dir — it also does
#   NOT recurse into db/migrations/). There is no migration runner in the Go API.
#   So on any database whose volume predates a schema change, later columns/tables
#   (e.g. drives.drive_type, the nodes table, drives.node_id) never get created,
#   and endpoints that reference them (e.g. /storage/breakdown, /storage/my-servers)
#   return 500. Run this after pulling schema changes to bring an existing DB up
#   to date. Every migration is idempotent (IF [NOT] EXISTS), so re-running is safe.
#
# USAGE
#   ./db/apply-migrations.sh                 # applies to the docker compose db-app service
#   PSQL="psql postgresql://user:pw@host/db" ./db/apply-migrations.sh   # direct psql
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$SCRIPT_DIR/migrations"

# Load .env from the repo root if present (for POSTGRES_APP_* and the psql target).
if [[ -f "$SCRIPT_DIR/../.env" ]]; then
  set -a; . "$SCRIPT_DIR/../.env"; set +a
fi

# Build the psql invocation. Override with $PSQL to point at any database.
if [[ -n "${PSQL:-}" ]]; then
  run_psql() { $PSQL -v ON_ERROR_STOP=1 "$@"; }
else
  DB_USER="${POSTGRES_APP_USER:?set POSTGRES_APP_USER or PSQL}"
  DB_NAME="${POSTGRES_APP_DB:?set POSTGRES_APP_DB or PSQL}"
  run_psql() {
    docker compose exec -T db-app \
      psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"
  }
fi

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "No migrations found in $MIGRATIONS_DIR" >&2
  exit 1
fi

echo "Applying ${#files[@]} migration(s) to the app database…"
for f in "${files[@]}"; do
  echo "  → $(basename "$f")"
  run_psql -f - < "$f"
done
echo "Done. All migrations applied (idempotent — safe to re-run)."
