-- Splits the drive tier benchmark into a sequential ("same sector") pass and
-- a random-access (random 4 KiB block) pass per disk, mirroring the split
-- industry tools like fio/CrystalDiskMark use, and adds direct_io so the
-- admin page can flag a disk whose mount doesn't support O_DIRECT — meaning
-- its numbers may still include page-cache effects instead of reflecting the
-- physical device. See docs/drive_benchmark_setup.md and
-- cmd/node-agent/benchmark.go.
--
-- write_mbps/read_mbps (057_drive_benchmark.sql) become seq_write_mbps/
-- seq_read_mbps — same meaning (one fsync'd write, then a sequential read),
-- just renamed to sit alongside the new random_* columns. Idempotent so it
-- can be re-applied safely against partially-migrated databases.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node_disk_benchmarks' AND column_name = 'write_mbps'
    ) THEN
        ALTER TABLE node_disk_benchmarks RENAME COLUMN write_mbps TO seq_write_mbps;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'node_disk_benchmarks' AND column_name = 'read_mbps'
    ) THEN
        ALTER TABLE node_disk_benchmarks RENAME COLUMN read_mbps TO seq_read_mbps;
    END IF;
END $$;

ALTER TABLE node_disk_benchmarks
    ADD COLUMN IF NOT EXISTS seq_write_mbps     DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS seq_read_mbps      DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS random_write_mbps  DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS random_write_iops  DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS random_read_mbps   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS random_read_iops   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS direct_io          BOOLEAN NOT NULL DEFAULT FALSE;
