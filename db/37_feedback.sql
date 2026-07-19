-- User feedback: free-text submissions from the profile page, triaged by admins.
-- user_id/username are denormalized (no FK — users' PK is TEXT, mirrors the
-- favorites/recognition_jobs convention of storing a UUID copy of the Keycloak
-- subject plus the username for display without a join).

CREATE TABLE feedback (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL,
    username   TEXT        NOT NULL,
    category   TEXT        NOT NULL,
    message    TEXT        NOT NULL,
    status     TEXT        NOT NULL DEFAULT 'new',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT feedback_category_check CHECK (category IN ('bug', 'feature', 'general')),
    CONSTRAINT feedback_status_check   CHECK (status IN ('new', 'reviewed', 'archived'))
);

CREATE INDEX feedback_status_idx  ON feedback (status, created_at DESC);
CREATE INDEX feedback_user_id_idx ON feedback (user_id);
