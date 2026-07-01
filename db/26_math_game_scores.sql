-- Math game scores: one row per completed game of the /math-game mental-math
-- test. Each row belongs to a single user (FK to users.username, the Keycloak
-- subject UUID stored as TEXT). Anonymous players are tracked client-side via
-- sessionStorage and never reach this table.
--
-- score is the number of correct answers out of total; duration_ms records how
-- long the game took. Rows are immutable once written (append-only history).

CREATE TABLE math_game_scores (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    username    TEXT        NOT NULL REFERENCES users (username) ON DELETE CASCADE,
    score       INTEGER     NOT NULL,
    total       INTEGER     NOT NULL,
    duration_ms BIGINT      NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT math_game_scores_total_positive CHECK (total > 0),
    CONSTRAINT math_game_scores_score_range    CHECK (score >= 0 AND score <= total),
    CONSTRAINT math_game_scores_duration_nonneg CHECK (duration_ms >= 0)
);

-- Newest-first listing per user is the only read pattern.
CREATE INDEX math_game_scores_username_created_idx
    ON math_game_scores (username, created_at DESC);

-- Row-level security: queries must run inside a transaction that sets
-- app.current_user_id to the requesting user's UUID via db.Queries.ForUser().
ALTER TABLE math_game_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE math_game_scores FORCE  ROW LEVEL SECURITY;

-- users.username is a UUID-shaped TEXT; compare against the RLS GUC directly.
CREATE POLICY math_game_scores_owned_by_current_user ON math_game_scores
    USING      (username = NULLIF(current_setting('app.current_user_id', true), ''))
    WITH CHECK (username = NULLIF(current_setting('app.current_user_id', true), ''));
