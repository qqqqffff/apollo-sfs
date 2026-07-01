-- Maps each user to one or more drives. The primary drive (is_primary = true)
-- is the default upload target; uploads fall back to the least-%-used owned
-- drive when the primary is full. The partial unique index enforces at most one
-- primary per user. Quota is tracked as a single aggregate on
-- users.storage_quota_bytes regardless of how many drives a user spans.

CREATE TABLE user_drive_allocations (
    user_id      TEXT        NOT NULL REFERENCES users (username),
    drive_id     UUID        NOT NULL REFERENCES drives (id),
    is_primary   BOOLEAN     NOT NULL DEFAULT true,
    allocated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT user_drive_allocations_pkey PRIMARY KEY (user_id, drive_id)
);

CREATE INDEX user_drive_allocations_drive_id_idx ON user_drive_allocations (drive_id);

-- At most one primary drive per user.
CREATE UNIQUE INDEX user_drive_allocations_one_primary
    ON user_drive_allocations (user_id) WHERE is_primary;
