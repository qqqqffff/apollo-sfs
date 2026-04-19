-- Admin-issued invitations. Only users with is_admin = true can create rows
-- (enforced in the route middleware, not the DB).
-- invited_by_user_id stores the inviting user's Keycloak subject UUID.
-- A partial unique index prevents duplicate pending invitations to the same
-- email address; accepted or revoked invitations do not block a re-invite.

CREATE TABLE invitations (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    invited_by_user_id UUID        NOT NULL,
    email              TEXT        NOT NULL,
    token              TEXT        NOT NULL UNIQUE,
    token_expires_at   TIMESTAMPTZ NOT NULL,
    accepted_at        TIMESTAMPTZ,
    revoked_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX invitations_pending_email_unique_idx
    ON invitations (email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;
