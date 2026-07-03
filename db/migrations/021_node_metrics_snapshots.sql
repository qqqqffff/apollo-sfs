-- Per-node hardware metrics + per-drive temperature history.
-- See db/29_node_metrics_snapshots.sql for the full column documentation.
-- Hardware metrics are now broken down by node (pushed by the per-node agent)
-- rather than collected only on the manager host.

CREATE TABLE IF NOT EXISTS node_metrics_snapshots (
    id                  UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id             UUID             NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    cpu_percent         DOUBLE PRECISION NOT NULL,
    cpu_temp_celsius    DOUBLE PRECISION,
    memory_used_bytes   BIGINT           NOT NULL,
    memory_total_bytes  BIGINT           NOT NULL,
    network_bytes_sent  BIGINT           NOT NULL,
    network_bytes_recv  BIGINT           NOT NULL,
    sampled_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS node_metrics_snapshots_node_sampled_idx
    ON node_metrics_snapshots (node_id, sampled_at DESC);

CREATE TABLE IF NOT EXISTS drive_temp_snapshots (
    id           UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    drive_id     UUID             NOT NULL REFERENCES drives (id) ON DELETE CASCADE,
    temp_celsius DOUBLE PRECISION NOT NULL,
    sampled_at   TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS drive_temp_snapshots_drive_sampled_idx
    ON drive_temp_snapshots (drive_id, sampled_at DESC);
