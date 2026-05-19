CREATE TABLE user_bans (
    id             BIGSERIAL    PRIMARY KEY,
    username       TEXT         NOT NULL REFERENCES users(username) ON UPDATE CASCADE ON DELETE CASCADE,
    ban_type       TEXT         NOT NULL CHECK (ban_type IN ('banned', 'suspended')),
    violation_code TEXT         NOT NULL,
    comments       TEXT         NOT NULL DEFAULT '',
    banned_by      TEXT         NOT NULL,
    banned_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at     TIMESTAMPTZ,          -- NULL = permanent ban; set for suspensions
    pardoned_at    TIMESTAMPTZ,          -- NULL = still active
    pardoned_by    TEXT
);

CREATE INDEX user_bans_username_idx ON user_bans(username, banned_at DESC);
CREATE INDEX user_bans_active_idx   ON user_bans(username) WHERE pardoned_at IS NULL;
