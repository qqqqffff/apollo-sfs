-- Per-user application preferences. One row per user, created lazily on first
-- write. user_id stores the Keycloak subject UUID as TEXT (matches users.username).
--
-- media_autoupload_folder_id, when set, causes every image/video upload to be
-- routed into that media folder automatically regardless of the upload target.
-- The folder is set NULL automatically if it is deleted.

CREATE TABLE user_preferences (
    user_id                    TEXT        PRIMARY KEY,
    media_autoupload_folder_id UUID        REFERENCES folders (id) ON DELETE SET NULL,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
