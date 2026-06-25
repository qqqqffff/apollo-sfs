-- Storage tier for each drive: 'nvme' (fast) or 'hdd' (standard). This is the
-- single source of truth for tier classification — set explicitly when a drive
-- is added (admin AddDrive), rather than re-derived from the label. See
-- db/migrations/020_drive_type.sql for the equivalent migration on existing DBs.
ALTER TABLE drives
    ADD COLUMN IF NOT EXISTS drive_type TEXT NOT NULL DEFAULT 'hdd'
        CHECK (drive_type IN ('nvme', 'hdd'));
