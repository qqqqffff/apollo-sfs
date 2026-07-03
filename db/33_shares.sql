-- Shares: user-to-user sharing of a single file or a folder subtree.
--
-- A share targets exactly one file OR one folder (enforced by shares_one_target)
-- and is addressed to a recipient email. The recipient must be logged in to an
-- account whose email matches recipient_email before the share resolves — the
-- token alone grants nothing.
--
-- owner_user_id  is the Keycloak subject UUID (matches files.user_id /
--                folders.user_id) used to scope RLS queries to the owner.
-- owner_username is the users-table primary key (preferred_username) used for
--                key decryption, quota accounting, and email lookups.
--
-- Permissions:
--   can_download     — file shares: the sharee may download (view is implicit).
--                      folder shares: the sharee may download contained files.
--   can_upload       — folder shares only: the sharee may upload into the folder.
--   include_children — folder shares only: the share covers all descendant
--                      folders, not just the folder's direct files.
--
-- Revocation is a soft delete (revoked_at) so the owner's history is kept.
-- Deleting the underlying file/folder cascades and removes the share entirely.

CREATE TABLE shares (
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

CREATE INDEX shares_owner_idx     ON shares (owner_user_id)   WHERE revoked_at IS NULL;
CREATE INDEX shares_recipient_idx ON shares (recipient_email) WHERE revoked_at IS NULL;

-- At most one active share of a given file/folder to a given recipient.
CREATE UNIQUE INDEX shares_active_file_unique
    ON shares (recipient_email, file_id)   WHERE revoked_at IS NULL AND file_id   IS NOT NULL;
CREATE UNIQUE INDEX shares_active_folder_unique
    ON shares (recipient_email, folder_id) WHERE revoked_at IS NULL AND folder_id IS NOT NULL;
