-- Admin-issued invitations. Only users with is_admin = true can create rows
-- (enforced in the route middleware, not the DB).
-- invited_by_user_id stores the inviting user's Keycloak subject UUID.
-- A partial unique index prevents duplicate pending invitations to the same
-- email address; accepted or revoked invitations do not block a re-invite.
-- grant_admin and grant_premium pre-assign Keycloak roles at registration time.
-- initial_drive_id, when set, bypasses auto-selection and allocates the user
-- directly to that drive.

CREATE TABLE invitations (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    invited_by_user_id  UUID        NOT NULL,
    email               TEXT        NOT NULL,
    token               TEXT        NOT NULL UNIQUE,
    token_expires_at    TIMESTAMPTZ NOT NULL,
    accepted_at         TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    initial_quota_bytes BIGINT      NOT NULL DEFAULT 10737418240,
    grant_admin         BOOLEAN     NOT NULL DEFAULT FALSE,
    grant_premium       BOOLEAN     NOT NULL DEFAULT FALSE,
    initial_drive_id    UUID        REFERENCES drives (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX invitations_pending_email_unique_idx
    ON invitations (email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;
