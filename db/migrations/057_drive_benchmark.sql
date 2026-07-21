-- Drive tier benchmarking. An admin-triggered write/read speed test per
-- physical disk, compared fast-tier (Pi 5 NVMe pool, averaged across both
-- drives) vs standard-tier (manager HDD). Unlike the passive I/O counters in
-- node_disk_io_snapshots, this is an active on-demand probe with no history —
-- one latest row per disk, upserted on every run (mirrors the single cached
-- SpeedTestResult pattern rather than the IO-history tables).
--
--   1. nodes.benchmark_requested_at — set by the admin trigger endpoint,
--      consumed (cleared) by node-metrics-ingest the next time that node's
--      agent pushes its regular metrics sample, which is what actually carries
--      the "please run a benchmark now" signal out to the node (node-agent has
--      no inbound listener — see docs/drive_benchmark_setup.md).
--   2. node_disk_benchmarks — latest write/read result per physical disk.
--   3. user_preferences.hide_benchmark_promo — hides the promo card in the Add
--      Storage modal, same pattern as show_storage_buttons/storage_prompt_enabled.
--
-- Idempotent so it can be re-applied safely against partially-migrated databases.

ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS benchmark_requested_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS node_disk_benchmarks (
    id          UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id     UUID             NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    label       TEXT             NOT NULL,
    write_mbps  DOUBLE PRECISION,
    read_mbps   DOUBLE PRECISION,
    size_bytes  BIGINT           NOT NULL DEFAULT 0,
    error       TEXT,
    tested_at   TIMESTAMPTZ      NOT NULL DEFAULT NOW(),

    UNIQUE (node_id, label)
);

ALTER TABLE user_preferences
    ADD COLUMN IF NOT EXISTS hide_benchmark_promo BOOLEAN NOT NULL DEFAULT FALSE;
