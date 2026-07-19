-- User feedback: free-text submissions from the profile page, triaged by
-- admins on a dedicated admin review page. See db/37_feedback.sql for the
-- full column commentary.

CREATE TABLE IF NOT EXISTS feedback (
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

CREATE INDEX IF NOT EXISTS feedback_status_idx  ON feedback (status, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_user_id_idx ON feedback (user_id);
