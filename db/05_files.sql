-- File metadata. The encrypted blob lives in MinIO at minio_object_key.
-- nonce is the AES-GCM nonce used to encrypt the blob.
-- user_id stores the Keycloak subject UUID (same type note as folders).
-- Deleting a folder cascades to its files here; the caller must also delete
-- the corresponding MinIO object before or after removing the metadata row.

CREATE TABLE files (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID        NOT NULL,
    folder_id        UUID        NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
    name             TEXT        NOT NULL,
    mime_type        TEXT        NOT NULL DEFAULT 'application/octet-stream',
    size_bytes       BIGINT      NOT NULL DEFAULT 0,
    minio_object_key TEXT        NOT NULL UNIQUE,
    nonce            BYTEA       NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT files_unique_name_per_folder UNIQUE (user_id, folder_id, name)
);

CREATE INDEX files_user_id_idx   ON files (user_id);
CREATE INDEX files_folder_id_idx ON files (folder_id);

-- ── Applied migrations ────────────────────────────────────────────────────────
-- 002_nullable_folder_id.sql
--   ALTER COLUMN folder_id DROP NOT NULL
--   DROP CONSTRAINT files_unique_name_per_folder
--   CREATE UNIQUE INDEX files_unique_name_per_folder (user_id, folder_id, name) WHERE folder_id IS NOT NULL
--   CREATE UNIQUE INDEX files_unique_name_at_root    (user_id, name)            WHERE folder_id IS NULL
-- 003_video_variants.sql
--   Creates the video_variants table (file_id FK → files.id ON DELETE CASCADE)
-- 004_rls_files_folders.sql
--   ENABLE ROW LEVEL SECURITY / FORCE ROW LEVEL SECURITY
--   CREATE POLICY files_owned_by_current_user (USING + WITH CHECK on app.current_user_id)
