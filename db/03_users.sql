-- Application users.
-- username is the Keycloak subject claim — a UUID stored as TEXT that serves as
-- the natural primary key. encrypted_key is the user's per-user AES-256 key
-- wrapped under the active master key; key_nonce is its AES-GCM nonce.
-- storage_used_bytes is updated atomically on every upload and deletion.

CREATE TABLE users (
    username            TEXT        PRIMARY KEY,
    email               TEXT        NOT NULL UNIQUE,
    encrypted_key       BYTEA       NOT NULL,
    key_nonce           BYTEA       NOT NULL,
    master_key_version  TEXT        NOT NULL REFERENCES master_keys (id),
    storage_used_bytes  BIGINT      NOT NULL DEFAULT 0,
    storage_quota_bytes BIGINT      NOT NULL DEFAULT 0,
    last_seen_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_admin            BOOLEAN     NOT NULL DEFAULT FALSE
);
