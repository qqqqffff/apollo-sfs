-- Maps each user to exactly one drive. All of their files (and their entire
-- quota) reside on that drive. Allocated at registration time using a best-fit
-- algorithm. Quota expansion is only permitted if the current drive has room.

CREATE TABLE user_drive_allocations (
    user_id      TEXT        NOT NULL PRIMARY KEY REFERENCES users (username),
    drive_id     UUID        NOT NULL REFERENCES drives (id),
    allocated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX user_drive_allocations_drive_id_idx ON user_drive_allocations (drive_id);
