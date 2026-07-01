-- Premium tier flag.
-- Premium is a one-time purchase (not a subscription) that unlocks the SFS
-- S3-like API. Membership is the source-of-truth in Keycloak (realm group
-- "premium"); this column is a denormalised mirror synced from the JWT on
-- every authenticated request in api/routes/middleware/auth.go RequireAuth.
-- Admins automatically inherit premium access at the application layer, so no
-- data backfill is performed here — the column defaults to FALSE and existing
-- rows are left untouched. Membership is reconciled from the JWT on the next
-- authenticated request.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_premium         BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS premium_granted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS users_is_premium_idx ON users (is_premium) WHERE is_premium = TRUE;
