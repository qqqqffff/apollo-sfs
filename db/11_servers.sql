-- Physical server registry. Each server hosts one MinIO instance that may serve
-- one or more drives (see `drives` table). Each drive maps to its own MinIO
-- bucket on the server's endpoint.
-- MinIO credentials are stored AES-256-GCM encrypted with KEY_ENCRYPTION_KEY.
-- Names are auto-generated as "{STATE}-{NNNN}" (e.g. "NH-0001") where STATE
-- is the 2-letter location code and NNNN is a zero-padded sequential number.

CREATE TABLE servers (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                   TEXT        NOT NULL UNIQUE,
    state                  TEXT        NOT NULL,
    minio_endpoint         TEXT        NOT NULL,
    minio_use_ssl          BOOLEAN     NOT NULL DEFAULT false,
    minio_access_key_enc   BYTEA       NOT NULL,
    minio_access_key_nonce BYTEA       NOT NULL,
    minio_secret_key_enc   BYTEA       NOT NULL,
    minio_secret_key_nonce BYTEA       NOT NULL,
    is_active              BOOLEAN     NOT NULL DEFAULT true,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
