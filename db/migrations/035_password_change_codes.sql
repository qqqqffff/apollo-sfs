-- Two-factor codes for the self-service change-password flow. A user requests a
-- code (emailed to their account address); it must be presented along with the
-- current and new password to actually change it. Codes are single-use,
-- short-lived, and stored hashed (SHA-256) — never in plaintext.
CREATE TABLE IF NOT EXISTS password_change_codes (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    username    TEXT        NOT NULL REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE,
    code_hash   BYTEA       NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS password_change_codes_username_idx
    ON password_change_codes (username);
