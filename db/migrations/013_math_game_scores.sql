-- Migration 013: add the math_game_scores table.
-- Stores per-user score history for the /math-game mental-math test. Mirrors
-- db/23_math_game_scores.sql for databases provisioned before that init script
-- existed. Uses IF NOT EXISTS guards so it is safe to apply to a live DB.

CREATE TABLE IF NOT EXISTS math_game_scores (
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

CREATE INDEX IF NOT EXISTS math_game_scores_username_created_idx
    ON math_game_scores (username, created_at DESC);

ALTER TABLE math_game_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE math_game_scores FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS math_game_scores_owned_by_current_user ON math_game_scores;
CREATE POLICY math_game_scores_owned_by_current_user ON math_game_scores
    USING      (username = NULLIF(current_setting('app.current_user_id', true), ''))
    WITH CHECK (username = NULLIF(current_setting('app.current_user_id', true), ''));
