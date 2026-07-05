-- 033: premium file-server mount links (WebDAV) + enhanced-security locations.
-- Mirrors db/35_file_server_links.sql (base schema for fresh installs) — keep in sync.

CREATE TABLE IF NOT EXISTS file_server_links (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    token             TEXT        NOT NULL UNIQUE,
    username          TEXT        NOT NULL REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE,
    user_id           UUID        NOT NULL,
    server_id         UUID        NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    drive_id          UUID        NOT NULL REFERENCES drives  (id) ON DELETE CASCADE,
    enhanced_security BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS file_server_links_user_server_unique
    ON file_server_links (username, server_id);
CREATE INDEX IF NOT EXISTS file_server_links_username_idx
    ON file_server_links (username);

CREATE TABLE IF NOT EXISTS file_server_link_locations (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    link_id              UUID        NOT NULL REFERENCES file_server_links (id) ON DELETE CASCADE,
    source_ip            TEXT        NOT NULL,
    verification_token   TEXT        UNIQUE,
    verification_sent_at TIMESTAMPTZ,
    verified_at          TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (link_id, source_ip)
);

CREATE INDEX IF NOT EXISTS file_server_link_locations_link_idx
    ON file_server_link_locations (link_id);
