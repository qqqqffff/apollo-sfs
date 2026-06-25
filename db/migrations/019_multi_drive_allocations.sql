-- Allow a user to be allocated drives on multiple servers (admin-assigned).
-- One allocation is the "primary" upload target; uploads fall back to the
-- least-%-used owned drive when the primary is full. The single
-- storage_used/quota_bytes total on users is unchanged — this only governs
-- which drive a new upload lands on and how reads resolve.
--
-- Existing single-drive rows become the primary automatically (DEFAULT true).

ALTER TABLE user_drive_allocations
    ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT true;

-- Replace the single-drive-per-user PK (user_id) with a composite (user_id, drive_id)
-- so a user can hold several allocations.
ALTER TABLE user_drive_allocations DROP CONSTRAINT IF EXISTS user_drive_allocations_pkey;
ALTER TABLE user_drive_allocations
    ADD CONSTRAINT user_drive_allocations_pkey PRIMARY KEY (user_id, drive_id);

-- At most one primary drive per user.
CREATE UNIQUE INDEX IF NOT EXISTS user_drive_allocations_one_primary
    ON user_drive_allocations (user_id) WHERE is_primary;
