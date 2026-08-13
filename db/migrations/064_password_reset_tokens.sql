-- App-owned password-reset tokens.
--
-- The forgot-password flow used to be Keycloak's: the API called the admin
-- endpoint /users/{id}/execute-actions-email with UPDATE_PASSWORD, and Keycloak
-- emailed a link to *its own* password form on auth.apollo-sfs.com. That is the
-- one flow that dropped a signed-in-to-be user onto raw Keycloak UI, and it was
-- broken besides (the admin call 400s when a redirect_uri is passed without a
-- client_id, so no mail was ever sent).
--
-- Reset is now owned by the app end to end, exactly like the change-password
-- two-factor codes in 035: a single-use, short-lived, hashed token is emailed
-- as a link to APP_BASE_URL/reset-password?token=..., the React page collects
-- the new password, and the API sets it through the Keycloak Admin API. No
-- Keycloak-rendered page is involved at any point.
--
-- Tokens are 32 random bytes, so a plain SHA-256 (no per-row salt, no argon2)
-- is enough to keep a database reader from replaying one: there is no
-- lower-entropy input to brute-force.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    username    TEXT        NOT NULL REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE,
    token_hash  BYTEA       NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup is by token alone (the reset link carries no username), so the hash
-- needs its own index; the username index backs the "invalidate outstanding
-- tokens" step when a fresh one is issued.
CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_token_hash_idx
    ON password_reset_tokens (token_hash);

CREATE INDEX IF NOT EXISTS password_reset_tokens_username_idx
    ON password_reset_tokens (username);
