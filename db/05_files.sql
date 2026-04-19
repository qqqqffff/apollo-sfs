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
