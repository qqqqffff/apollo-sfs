# Database Layer

PostgreSQL 16 with the `pgcrypto` extension. Two separate database instances run in Docker:

| Instance | Service | Used by |
|----------|---------|---------|
| `db-app` | PostgreSQL 16 Alpine | Go API (`POSTGRES_APP_*`) |
| `db-keycloak` | PostgreSQL 16 Alpine | Keycloak (`POSTGRES_KC_*`) |

## Schema Files

Files in `db/` are numbered and applied in order during initial container creation (mounted at `/docker-entrypoint-initdb.d`). Each file defines one table. The numbering reflects creation order — dependencies appear before dependents.

| File | Table(s) | Notes |
|------|---------|-------|
| `00_extensions.sql` | — | Enables `pgcrypto` (UUID, crypto functions) |
| `01_master_keys.sql` | `master_keys` | Versioned master encryption keys |
| `02_key_rotation_log.sql` | `key_rotation_log` | Audit log for master key rotation events |
| `03_users.sql` | `users` | Accounts; `username` = Keycloak UUID (sub claim) |
| `04_servers.sql` | `servers` | Storage server registry |
| `05_nodes.sql` | `nodes` | Per-server Swarm nodes (server → node → drive topology) |
| `06_drives.sql` | `drives` | Individual MinIO-backed drives per node |
| `07_user_drive_allocations.sql` | `user_drive_allocations` | Per-user drive assignment and primary-drive flag |
| `08_invitations.sql` | `invitations` | Token-based invite flow |
| `09_folders.sql` | `folders` | Recursive folder hierarchy (RLS enabled) |
| `10_devices.sql` | `devices` | Mobile device registration |
| `11_files.sql` | `files` | File metadata, encryption nonces (RLS enabled) |
| `12_video_variants.sql` | `video_variants` | FFmpeg transcode quality variants |
| `13_favorites.sql` | `favorites` | Per-user file/folder favorites |
| `14_user_preferences.sql` | `user_preferences` | UI preferences (media auto-upload folder, etc.) |
| `15_collection_items.sql` | `collection_items` | Media collection item pointers |
| `16_deleted_file_log.sql` | `deleted_file_log` | Mobile delta-sync deletion tombstones |
| `17_api_keys.sql` | `api_keys`, `api_key_scopes` | SFS API credentials (argon2id + pepper) |
| `18_payments.sql` | `payments` | PayPal premium-tier order records |
| `19_storage_orders.sql` | `storage_orders` | Storage add-on purchase records |
| `20_server_expansion_requests.sql` | `server_expansion_requests` | Infrastructure capacity expansion requests |
| `21_audit_logs.sql` | `audit_logs` | Admin action audit trail |
| `22_user_bans.sql` | `user_bans` | User ban and suspension records |
| `23_banned_ips.sql` | `banned_ips` | IPs banned by fail2ban |
| `24_email_queue.sql` | `email_queue` | Async outbound email delivery queue |
| `25_inbound_emails.sql` | `inbound_emails` | Parsed inbound email index (SendGrid webhook) |
| `26_math_game_scores.sql` | `math_game_scores` | Mental-math game leaderboard |
| `27_interest_form.sql` | `interest_submissions`, `interest_deposit_orders`, `interest_form_settings` | Early access signups (fixed-plan pricing + 50% deposit, no custom amounts) |
| `28_alarm_settings.sql` | `alarm_settings` | Cluster-wide alarm subscriber email arrays |
| `29_alarm_subscriptions.sql` | `alarm_subscriptions` | Per-node/drive alarm subscriptions with thresholds |
| `30_server_metrics_snapshots.sql` | `server_metrics_snapshots` | Manager-host metrics history |
| `31_node_metrics_snapshots.sql` | `node_metrics_snapshots`, `drive_temp_snapshots` | Per-node hardware metrics history |
| `32_node_disks.sql` | `node_disks`, `node_disk_temp_snapshots` | Physical disk telemetry |
| `33_shares.sql` | `shares` | User-to-user file/folder shares (email-bound link tokens) |
| `34_expansion_invoices.sql` | `expansion_invoices` | Invoices for custom capacity expansion requests |

## Migrations

Incremental schema changes live in `db/migrations/NNN_name.sql`. They are **not** applied automatically — the API has no migration runner. Migrations are applied manually to existing databases using the provided script.

```bash
# Apply all pending migrations to the running Swarm db-app container
# (idempotent — safe to re-run; finds the apollo-sfs_db-app container via `docker ps`)
./db/apply-migrations.sh

# Apply against a specific database instead (direct psql, or a docker-compose dev stack)
PSQL="psql postgresql://user:pw@host/db" ./db/apply-migrations.sh
PSQL="docker compose exec -T db-app psql" ./db/apply-migrations.sh
```

The script reads `POSTGRES_APP_USER` and `POSTGRES_APP_DB` from `.env` if present, otherwise uses the `$PSQL` override. It applies every file in `db/migrations/` in numeric order. `deploy.sh --migrate` runs it before build/deploy.

To add a migration:
1. Create `db/migrations/<N+1>_description.sql`
2. Write idempotent SQL (use `IF NOT EXISTS`, `IF EXISTS`, `ON CONFLICT`, etc.)
3. Run `./db/apply-migrations.sh` against any existing database that needs the change

**Never modify already-applied migration files.** Write a new one instead. Fresh installs apply only the base schema files and do not need migrations.

## Row-Level Security

RLS is enabled on `files`, `folders`, `api_keys`, `api_key_scopes`, and `math_game_scores`. Before executing any query against those tables, the API calls:

```go
db.Queries.ForUser(userID)
// which executes: SET LOCAL app.current_user_id = '<uuid>'
```

RLS policies reject rows where `user_id` does not match `current_setting('app.current_user_id')`. This is a hard data isolation guarantee at the database layer, independent of application logic.

## Encryption Model

```
Master key (KEY_ENCRYPTION_KEY env var)
  └── Per-user AES-256-GCM key  (stored in users.encrypted_key / users.key_nonce)
        └── File content encrypted in MinIO
              └── Nonce stored in files.nonce
```

Key rotation bumps the version in `master_keys` and re-wraps each user's key. The `key_rotation_log` records which master key version each user's key is currently wrapped under.

## Storage Topology

```
servers
  └── nodes          (one or more Swarm nodes per server)
        └── drives   (one or more MinIO-backed drives per node)
              └── user_drive_allocations  (per-user drive assignment + quota)
```

A node may override the parent server's `minio_endpoint` so that a single logical server can span multiple MinIO instances (e.g., a fast-tier NVMe node and a standard-tier HDD node). Drives resolve their endpoint by checking their node's `minio_endpoint` first, falling back to the server's.

## Connecting Locally

```bash
# App database
psql "postgresql://${POSTGRES_APP_USER}:${POSTGRES_APP_PASSWORD}@localhost:5432/${POSTGRES_APP_DB}"

# Keycloak database
psql "postgresql://${POSTGRES_KC_USER}:${POSTGRES_KC_PASSWORD}@localhost:5433/${POSTGRES_KC_DB}"
```

Ports may differ depending on host-port mappings in docker-compose.yml.

## Backup

PostgreSQL data lives in named Docker volumes. Back up with:

```bash
docker exec <db-app-container> pg_dump -U "${POSTGRES_APP_USER}" "${POSTGRES_APP_DB}" | gzip > backup.sql.gz
```

For the 8 TB HDD on the manager node, schedule this via cron and ship the compressed dump off-node.
