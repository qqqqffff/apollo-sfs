-- 028: user-to-user sharing of files and folders.
-- Mirrors db/33_shares.sql (base schema for fresh installs) — keep in sync.

CREATE TABLE IF NOT EXISTS shares (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    token            TEXT        NOT NULL UNIQUE,
    owner_user_id    UUID        NOT NULL,
    owner_username   TEXT        NOT NULL REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE,
    recipient_email  TEXT        NOT NULL,
    file_id          UUID        REFERENCES files (id)   ON DELETE CASCADE,
    folder_id        UUID        REFERENCES folders (id) ON DELETE CASCADE,
    can_download     BOOLEAN     NOT NULL DEFAULT FALSE,
    can_upload       BOOLEAN     NOT NULL DEFAULT FALSE,
    include_children BOOLEAN     NOT NULL DEFAULT FALSE,
    revoked_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT shares_one_target CHECK ((file_id IS NULL) <> (folder_id IS NULL))
);

CREATE INDEX IF NOT EXISTS shares_owner_idx     ON shares (owner_user_id)   WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS shares_recipient_idx ON shares (recipient_email) WHERE revoked_at IS NULL;

-- At most one active share of a given file/folder to a given recipient.
CREATE UNIQUE INDEX IF NOT EXISTS shares_active_file_unique
    ON shares (recipient_email, file_id)   WHERE revoked_at IS NULL AND file_id   IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shares_active_folder_unique
    ON shares (recipient_email, folder_id) WHERE revoked_at IS NULL AND folder_id IS NOT NULL;
