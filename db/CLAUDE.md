# Database Layer

PostgreSQL 16 with the `pgcrypto` extension. Two separate database instances run in Docker:

| Instance | Service | Used by |
|----------|---------|---------|
| `db-app` | PostgreSQL 16 Alpine | Go API (`POSTGRES_APP_*`) |
| `db-keycloak` | PostgreSQL 16 Alpine | Keycloak (`POSTGRES_KC_*`) |

The Go API automatically runs all pending migrations on startup. Do not apply migrations manually in production.

## Schema Files

Files in `/db/` are numbered and applied in order during initial container creation. Migration changes go in `/db/migrations/` instead.

| File | Table(s) | Notes |
|------|---------|-------|
| `00_extensions.sql` | — | Enables `pgcrypto` (UUID, crypto functions) |
| `01_master_keys.sql` | `master_keys` | Versioned master encryption keys |
| `02_key_rotation_log.sql` | `key_rotation_log` | Tracks which key version each user's key is wrapped under |
| `03_users.sql` | `users` | Accounts; `username` = Keycloak UUID (sub claim) |
| `04_folders.sql` | `folders` | Recursive folder hierarchy |
| `05_files.sql` | `files`, `video_variants` | File metadata, encryption nonces, video transcode status |
| `06_invitations.sql` | `invitations` | Token-based invite flow |
| `07_email_queue.sql` | `email_queue` | Async outbound email delivery |
| `08_server_metrics_snapshots.sql` | `server_metrics_snapshots` | Historical metric data |
| `09_favorites.sql` | `favorites` | Per-user file/folder favorites |
| `10_banned_ips.sql` | `banned_ips` | Fail2ban records IPs here via `record-ban.sh` |
| `11_servers.sql` | `servers` | Storage server topology (manager vs. Pi 5) |
| `12_drives.sql` | `drives` | Individual drives per server |
| `13_user_drive_allocations.sql` | `user_drive_allocations` | Per-user quota per drive |
| `14_interest_form.sql` | `interest_form` | Early access signups |
| `15_alarm_settings.sql` | `alarm_settings` | Per-user notification/alert preferences |
| `16_audit_logs.sql` | `audit_logs` | Activity audit trail |
| `17_user_bans.sql` | `user_bans` | User suspension records |
| `18_user_preferences.sql` | `user_preferences` | UI preferences (theme, sort order, etc.) |
| `19_collection_items.sql` | `collection_items` | Media collections (albums, galleries) |
| `20_api_keys.sql` | `api_keys` | SFS API credentials (argon2id + pepper) |
| `21_payments.sql` | `payments` | PayPal order records |
| `22_inbound_emails.sql` | `inbound_emails` | Parsed inbound email storage |
| `23_math_game_scores.sql` | `math_game_scores` | Gamification leaderboard |
| `24_devices.sql` | `devices` | Mobile device registration |
| `25_deleted_file_log.sql` | `deleted_file_log` | Soft-delete audit trail |
| `26_storage_orders.sql` | `storage_orders` | Tier upgrade order records |
| `27_server_expansion_requests.sql` | `server_expansion_requests` | Infrastructure capacity requests |
| `28_nodes.sql` | `nodes` | Individual storage node metadata |

## Migrations

Live in `api/migrations/` (20 versioned SQL files). The Go API runs them on startup via `db.RunMigrations()`. Each migration is idempotent (uses `IF NOT EXISTS`, `IF EXISTS`, or a migration-tracking table).

To add a migration:
1. Create `api/migrations/<N+1>_description.sql`
2. Write idempotent SQL
3. The next API startup applies it automatically

Never modify already-applied migration files. Write a new one instead.

## Row-Level Security

RLS is enabled on `files` and `folders`. Before executing any query against those tables, the API calls:

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

## Unique Constraints

- `files`: `UNIQUE (user_id, folder_id, name)` — prevents duplicate names within a folder
- `files`: `UNIQUE (user_id, name)` WHERE `folder_id IS NULL` — prevents duplicates at root level

If an upload would violate these, the API returns a conflict error before touching MinIO.

## Video Variants

`video_variants` is a child table of `files`. FFmpeg background transcoding writes rows with status `pending` → `ready` or `failed`. Cascade delete ensures variants are removed when the parent file is deleted.

## Multi-Tier Storage Topology

```
servers
  └── drives          (one or more drives per server)
        └── nodes     (logical storage nodes, e.g. a MinIO instance)
              └── user_drive_allocations  (per-user quota assigned to this drive)
```

The `servers` table has rows for the manager node (HDD, standard tier) and the Pi 5 (NVMe pool, fast tier). The API's storage routing logic reads this topology to decide where to upload each file.

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