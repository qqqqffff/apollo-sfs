-- Tracks each folder tier/server-change job kicked off by a user changing a
-- folder's pinned drive (see 026_folders_drive_id.sql). Also doubles as the
-- rate-limit ledger for that operation — the API counts rows for a folder
-- created within the last 30 days rather than maintaining a separate counter.

CREATE TABLE IF NOT EXISTS folder_drive_migrations (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    folder_id     UUID        NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
    user_id       UUID        NOT NULL,
    from_drive_id UUID        REFERENCES drives (id),
    to_drive_id   UUID        NOT NULL REFERENCES drives (id),
    status        TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','failed')),
    total_files   INT         NOT NULL DEFAULT 0,
    files_moved   INT         NOT NULL DEFAULT 0,
    total_bytes   BIGINT      NOT NULL DEFAULT 0,
    bytes_moved   BIGINT      NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS folder_drive_migrations_folder_id_idx ON folder_drive_migrations (folder_id);
CREATE INDEX IF NOT EXISTS folder_drive_migrations_user_id_idx   ON folder_drive_migrations (user_id);

ALTER TABLE folder_drive_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE folder_drive_migrations FORCE  ROW LEVEL SECURITY;

-- CREATE POLICY has no IF NOT EXISTS form, so drop first to stay idempotent
-- (matches 004_rls_files_folders.sql).
DROP POLICY IF EXISTS folder_drive_migrations_owned_by_current_user ON folder_drive_migrations;
CREATE POLICY folder_drive_migrations_owned_by_current_user ON folder_drive_migrations
    USING      (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
