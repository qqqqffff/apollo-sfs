-- Migration 013: mobile sync — sha256 content hash, device registry, deletion tombstones.

-- ── Files: content hash for client-side deduplication ────────────────────────
-- Populated by the API on upload and finalized chunked upload.
-- NULL for files uploaded before this migration; the index is partial so those
-- rows are excluded and the dedup path is simply skipped for legacy uploads.

ALTER TABLE files
    ADD COLUMN sha256_hash TEXT;

CREATE INDEX files_sha256_idx ON files (user_id, sha256_hash)
    WHERE sha256_hash IS NOT NULL;

-- ── Devices ───────────────────────────────────────────────────────────────────
-- Tracks registered mobile devices for per-device sync cursors and (future)
-- push notification delivery.

CREATE TABLE devices (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL,
    name         TEXT        NOT NULL,
    platform     TEXT        NOT NULL CHECK (platform IN ('ios', 'android')),
    push_token   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX devices_user_id_idx ON devices (user_id);

-- ── Deleted-file log ─────────────────────────────────────────────────────────
-- Tombstones consumed by the delta-sync endpoint so mobile clients learn about
-- server-side deletions.  Rows older than 90 days can be pruned.

CREATE TABLE deleted_file_log (
    id         UUID        NOT NULL,
    user_id    UUID        NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX deleted_file_log_user_deleted ON deleted_file_log (user_id, deleted_at);
