-- Completed-run log for Google Drive/Photos backups — the Google-backup
-- counterpart to email_backup_runs (050_email_backup.sql). Google backup has
-- no dedicated per-message index table (uploaded files are just regular
-- `files` rows tagged with source IN ('google_drive','google_photos')); this
-- table exists solely to back the "notify me when complete" setting so a
-- finished run (foreground or background) can surface in the notification
-- bell the same way an email backup run does.
-- Idempotent so it can be re-applied safely against partially-migrated databases.

CREATE TABLE IF NOT EXISTS google_backup_runs (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    username     TEXT        NOT NULL,   -- bell queries are keyed by username
    user_id      UUID        NOT NULL,
    uploaded     INTEGER     NOT NULL DEFAULT 0,
    duplicates   INTEGER     NOT NULL DEFAULT 0,
    errors       INTEGER     NOT NULL DEFAULT 0,
    notify       BOOLEAN     NOT NULL DEFAULT FALSE,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS google_backup_runs_username_completed_idx
    ON google_backup_runs (username, completed_at DESC);
