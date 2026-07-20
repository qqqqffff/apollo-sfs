-- Email backup feature.
-- Users back up messages from an external mail provider (Gmail / Microsoft)
-- into a dedicated folder of kind 'email' (name = the mail address). Each
-- message body is a normal encrypted file in MinIO (quota/tier enforced by the
-- regular upload path); these tables are the queryable index over those files
-- plus the completed-run log that backs the "backup finished" notification.
-- Idempotent so it can be re-applied safely against partially-migrated databases.

-- ── Message index ─────────────────────────────────────────────────────────────
-- One row per backed-up message. The full message (StoredEmail JSON) lives in
-- the encrypted file referenced by file_id; this row carries only the metadata
-- needed to render the list pane without decrypting anything.
CREATE TABLE IF NOT EXISTS email_backup_messages (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        NOT NULL,   -- Keycloak sub UUID (files.user_id convention)
    folder_id           UUID        NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
    file_id             UUID        NOT NULL REFERENCES files   (id) ON DELETE CASCADE,
    provider            TEXT        NOT NULL,   -- 'gmail' | 'microsoft'
    provider_message_id TEXT        NOT NULL,   -- provider-side id, dedupe key per folder
    from_addr           TEXT        NOT NULL DEFAULT '',
    to_addr             TEXT        NOT NULL DEFAULT '',
    subject             TEXT        NOT NULL DEFAULT '',
    snippet             TEXT        NOT NULL DEFAULT '',
    has_attachments     BOOLEAN     NOT NULL DEFAULT FALSE,
    starred             BOOLEAN     NOT NULL DEFAULT FALSE,
    read                BOOLEAN     NOT NULL DEFAULT FALSE,   -- read state inside our viewer
    received_at         TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (folder_id, provider_message_id)
);

CREATE INDEX IF NOT EXISTS email_backup_messages_folder_received_idx
    ON email_backup_messages (folder_id, received_at DESC);
CREATE INDEX IF NOT EXISTS email_backup_messages_file_idx
    ON email_backup_messages (file_id);

ALTER TABLE email_backup_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_backup_messages FORCE  ROW LEVEL SECURITY;

-- CREATE POLICY has no IF NOT EXISTS form, so drop first to stay idempotent
-- (matches 004_rls_files_folders.sql).
DROP POLICY IF EXISTS email_backup_messages_owned_by_current_user ON email_backup_messages;
CREATE POLICY email_backup_messages_owned_by_current_user ON email_backup_messages
    USING      (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

-- ── Completed run log ─────────────────────────────────────────────────────────
-- One row per finished backup run. Rows with notify = TRUE surface in the
-- notification bell (derived live like every other bell category, dismissal
-- via dismissed_notifications with the "<id>:email-backup" suffix).
CREATE TABLE IF NOT EXISTS email_backup_runs (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT        NOT NULL,   -- bell queries are keyed by username
    user_id       UUID        NOT NULL,
    folder_id     UUID        REFERENCES folders (id) ON DELETE SET NULL,
    email_address TEXT        NOT NULL,
    provider      TEXT        NOT NULL,
    uploaded      INTEGER     NOT NULL DEFAULT 0,
    duplicates    INTEGER     NOT NULL DEFAULT 0,
    errors        INTEGER     NOT NULL DEFAULT 0,
    notify        BOOLEAN     NOT NULL DEFAULT FALSE,
    completed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_backup_runs_username_completed_idx
    ON email_backup_runs (username, completed_at DESC);
