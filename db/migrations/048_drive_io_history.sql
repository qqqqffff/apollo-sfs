-- Historical read/write I/O throughput, alongside the existing temperature
-- history tables (drive_temp_snapshots, node_disk_temp_snapshots) added in
-- 32_node_disks.sql. read_bytes/write_bytes are cumulative counters (mirrors
-- node_metrics_snapshots.network_bytes_sent/recv) — diff two adjacent rows
-- over their sampled_at delta to get bytes/second, the same way network
-- throughput history is derived. One row per sample per disk/drive, pruned at
-- 7 days like the rest of the metrics (see MetricsService.runPruner).
--
-- Two tables, mirroring the dual drive_temp_snapshots / node_disk_temp_snapshots
-- split: node_disk_io_snapshots is keyed by the physical disk (independent of
-- logical drives, so one disk in a pool is visible on its own); drive_io_snapshots
-- is keyed by the registered logical drive (only written when the reporting
-- disk's label backs one).

CREATE TABLE IF NOT EXISTS node_disk_io_snapshots (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    disk_id     UUID        NOT NULL REFERENCES node_disks (id) ON DELETE CASCADE,
    read_bytes  BIGINT      NOT NULL DEFAULT 0,
    write_bytes BIGINT      NOT NULL DEFAULT 0,
    sampled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS node_disk_io_snapshots_disk_sampled_idx
    ON node_disk_io_snapshots (disk_id, sampled_at DESC);

CREATE TABLE IF NOT EXISTS drive_io_snapshots (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    drive_id    UUID        NOT NULL REFERENCES drives (id) ON DELETE CASCADE,
    read_bytes  BIGINT      NOT NULL DEFAULT 0,
    write_bytes BIGINT      NOT NULL DEFAULT 0,
    sampled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS drive_io_snapshots_drive_sampled_idx
    ON drive_io_snapshots (drive_id, sampled_at DESC);
