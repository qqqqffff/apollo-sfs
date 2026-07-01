-- Persist the drive storage tier (nvme = fast, hdd = standard) on the drives
-- table instead of re-deriving it from a brittle `lower(label) LIKE '%nvme%'`
-- heuristic duplicated across queries (db/drives.go, db/servers.go,
-- db/storage_orders.go). New drives set drive_type explicitly at creation
-- (admin AddDrive).
--
-- No data backfill: the column defaults to 'hdd' and existing rows are left
-- untouched so re-running never changes a drive's tier. Adjust any legacy rows
-- manually if their tier needs correcting.

ALTER TABLE drives
    ADD COLUMN IF NOT EXISTS drive_type TEXT NOT NULL DEFAULT 'hdd'
        CHECK (drive_type IN ('nvme', 'hdd'));
