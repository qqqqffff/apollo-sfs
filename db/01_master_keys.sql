-- Master encryption keys.
-- id is a human-readable version string (e.g. "v1", "v2") set by the application.
-- encrypted_key_material and key_nonce are NULLed out when a key is purged;
-- the row is retained for audit purposes.
-- A partial unique index enforces that at most one key can be active at a time.

CREATE TYPE master_key_status AS ENUM ('active', 'retiring', 'deleted');

CREATE TABLE master_keys (
    id                     TEXT              PRIMARY KEY,
    encrypted_key_material BYTEA,
    key_nonce              BYTEA,
    status                 master_key_status NOT NULL,
    created_at             TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
    retired_at             TIMESTAMPTZ,
    deleted_at             TIMESTAMPTZ
);

CREATE UNIQUE INDEX master_keys_one_active_idx
    ON master_keys (status)
    WHERE status = 'active';
