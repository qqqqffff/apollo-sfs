-- Premium tier flag.
-- Premium is a one-time purchase (not a subscription) that unlocks the SFS
-- S3-like API. Membership is the source-of-truth in Keycloak (realm group
-- "premium"); this column is a denormalised mirror synced from the JWT on
-- every authenticated request in api/routes/middleware/auth.go RequireAuth.
-- Admins automatically inherit premium access at the application layer; the
-- backfill below grants premium to existing admins so they have it on day one.

ALTER TABLE users
    ADD COLUMN is_premium         BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN premium_granted_at TIMESTAMPTZ;

UPDATE users
   SET is_premium         = TRUE,
       premium_granted_at = NOW()
 WHERE is_admin = TRUE;

CREATE INDEX users_is_premium_idx ON users (is_premium) WHERE is_premium = TRUE;
