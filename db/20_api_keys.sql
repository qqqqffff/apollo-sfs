-- API keys for the SFS S3-like API.
-- Each key belongs to a single user (FK to users.username, which is the
-- Keycloak subject UUID stored as TEXT). The raw secret is shown only once
-- at issuance; the database stores key_prefix (lookup) and key_hash
-- (argon2id over the secret half, peppered by SFS_API_KEY_PEPPER).
--
-- Scopes live in api_key_scopes and are enforced at request time by the
-- SFS handlers via services/api_key.go Authorize(). A key with zero scope
-- rows is rejected (no implicit "everything").

CREATE TABLE api_keys (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT        NOT NULL REFERENCES users (username) ON DELETE CASCADE,
    name          TEXT        NOT NULL,
    key_prefix    TEXT        NOT NULL UNIQUE,
    key_hash      TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at  TIMESTAMPTZ,
    expires_at    TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ
);

CREATE INDEX api_keys_username_idx ON api_keys (username);

CREATE TABLE api_key_scopes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id  UUID NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
    operation   TEXT NOT NULL CHECK (operation IN ('read', 'write', 'delete', 'list')),
    path_prefix TEXT NOT NULL,
    UNIQUE (api_key_id, operation, path_prefix)
);

CREATE INDEX api_key_scopes_api_key_id_idx ON api_key_scopes (api_key_id);

-- Row-level security: queries must run inside a transaction that sets
-- app.current_user_id to the requesting user's UUID via db.Queries.ForUser().
ALTER TABLE api_keys       ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys       FORCE  ROW LEVEL SECURITY;
ALTER TABLE api_key_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_scopes FORCE  ROW LEVEL SECURITY;

-- users.username is a UUID-shaped TEXT; cast the RLS GUC to text for compare.
CREATE POLICY api_keys_owned_by_current_user ON api_keys
    USING      (username = NULLIF(current_setting('app.current_user_id', true), ''))
    WITH CHECK (username = NULLIF(current_setting('app.current_user_id', true), ''));

CREATE POLICY api_key_scopes_owned_by_current_user ON api_key_scopes
    USING      (EXISTS (
                    SELECT 1 FROM api_keys k
                     WHERE k.id = api_key_scopes.api_key_id
                       AND k.username = NULLIF(current_setting('app.current_user_id', true), '')
                ))
    WITH CHECK (EXISTS (
                    SELECT 1 FROM api_keys k
                     WHERE k.id = api_key_scopes.api_key_id
                       AND k.username = NULLIF(current_setting('app.current_user_id', true), '')
                ));
