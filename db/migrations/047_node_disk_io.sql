-- Per-disk I/O throughput, alongside the existing capacity/temperature telemetry
-- on node_disks. read_bytes/write_bytes are cumulative counters reported by the
-- node agent (mirrors network_bytes_sent/recv on node_metrics_snapshots) — the
-- API diffs consecutive live frames to derive a read/write bytes-per-second
-- rate for the drive-speed carousel card, so no separate history table is
-- needed (capacity_bytes/used_bytes/free_bytes work the same way already).

ALTER TABLE node_disks
    ADD COLUMN IF NOT EXISTS read_bytes  BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS write_bytes BIGINT NOT NULL DEFAULT 0;
