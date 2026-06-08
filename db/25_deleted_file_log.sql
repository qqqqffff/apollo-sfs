-- Deletion tombstones consumed by the mobile delta-sync endpoint.
-- Rows older than 90 days may be pruned; clients that haven't synced in
-- 90 days must perform a full re-sync.

CREATE TABLE deleted_file_log (
    id         UUID        NOT NULL,
    user_id    UUID        NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX deleted_file_log_user_deleted_idx ON deleted_file_log (user_id, deleted_at);
