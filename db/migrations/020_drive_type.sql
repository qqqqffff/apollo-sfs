-- Persist the drive storage tier (nvme = fast, hdd = standard) on the drives
-- table instead of re-deriving it from a brittle `lower(label) LIKE '%nvme%'`
-- heuristic duplicated across queries (db/drives.go, db/servers.go,
-- db/storage_orders.go). New drives set drive_type explicitly at creation
-- (admin AddDrive); this backfills existing rows from the old heuristic so
-- behaviour is unchanged for current data.

ALTER TABLE drives
    ADD COLUMN IF NOT EXISTS drive_type TEXT NOT NULL DEFAULT 'hdd'
        CHECK (drive_type IN ('nvme', 'hdd'));

-- One-time backfill from the legacy label heuristic.
UPDATE drives
SET drive_type = CASE WHEN lower(label) LIKE '%nvme%' THEN 'nvme' ELSE 'hdd' END;
