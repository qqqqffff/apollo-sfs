-- Premium file-server mount links (WebDAV).
-- A link lets its owner mount one drive — a single server + storage tier
-- (fast/NVMe or standard/HDD) — as a network drive via
-- https://<app>/dav/<token> with full file management (upload, download,
-- delete, move, copy). The DAV handler serves every file as an opaque
-- attachment (no previews), and nothing is ever executed server-side.
--
-- Exactly one link may exist per (user, drive) — enforced by the unique
-- index below. A server that exposes both tiers to a user therefore yields
-- two independently mountable links, one per drive. Deleting a link (or
-- losing premium) hard-DELETEs the row, which immediately kills the mount:
-- every DAV request re-resolves the token against this table.
--
-- drive_id pins the mount to the user's allocated drive at creation time;
-- uploads through the mount are pinned to it and the mount only exposes
-- files stored on that exact drive (not other drives/tiers on the same
-- server).

CREATE TABLE IF NOT EXISTS file_server_links (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    token             TEXT        NOT NULL UNIQUE,
    -- users.username is the Keycloak subject UUID stored as TEXT.
    username          TEXT        NOT NULL REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE,
    -- Keycloak sub as a UUID (files.user_id / folders.user_id FK domain).
    user_id           UUID        NOT NULL,
    server_id         UUID        NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    drive_id          UUID        NOT NULL REFERENCES drives  (id) ON DELETE CASCADE,
    -- When TRUE, uploads/downloads from an unverified location (source IP)
    -- are rejected until the owner clicks an emailed verification link.
    -- Verifications expire after 30 days.
    enhanced_security BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at      TIMESTAMPTZ
);

-- One link per drive per user (a server exposing two tiers to a user yields
-- two links, one per drive).
CREATE UNIQUE INDEX IF NOT EXISTS file_server_links_user_drive_unique
    ON file_server_links (username, drive_id);
CREATE INDEX IF NOT EXISTS file_server_links_username_idx
    ON file_server_links (username);

-- Enhanced-security location ledger: one row per (link, source IP).
-- A location is trusted when verified_at is within the last 30 days;
-- otherwise a fresh verification_token is issued and emailed.
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
