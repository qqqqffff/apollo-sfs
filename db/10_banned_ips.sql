-- Tracks IPs banned by fail2ban for audit purposes and future reference.
-- One row per IP; repeat bans increment ban_count rather than adding rows.

CREATE TABLE IF NOT EXISTS banned_ips (
    id          BIGSERIAL    PRIMARY KEY,
    ip          INET         NOT NULL,
    jail        TEXT         NOT NULL DEFAULT 'nginx-api-scan',
    banned_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    unbanned_at TIMESTAMPTZ,
    ban_count   INT          NOT NULL DEFAULT 1
);

-- Fast lookup by IP (supports both exact and subnet queries via &&).
CREATE UNIQUE INDEX IF NOT EXISTS banned_ips_ip_idx ON banned_ips (ip);
-- Useful for querying currently-active bans or bans by date range.
CREATE INDEX IF NOT EXISTS banned_ips_banned_at_idx ON banned_ips (banned_at DESC);
