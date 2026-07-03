-- Per-node hardware metrics, sampled every 5 seconds and pushed to the API by
-- the per-node agent (api/cmd/node-agent) running in Docker Swarm "global" mode
-- (one replica per node). Unlike server_metrics_snapshots (cluster/uplink + app
-- metrics collected on the manager), these rows break hardware down by node so
-- the admin metrics page can show each node's own CPU, memory, and network.
--
-- network_bytes_sent / network_bytes_recv are cumulative counters since boot;
-- diff two adjacent rows over their sampled_at delta to get bytes/second.
-- cpu_temp_celsius is nullable: nodes lacking accessible sensors omit it.
-- Rows older than 7 days are pruned daily by the metrics service.

CREATE TABLE node_metrics_snapshots (
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

-- Per-node history queries filter on node_id and scan by sampled_at.
CREATE INDEX node_metrics_snapshots_node_sampled_idx
    ON node_metrics_snapshots (node_id, sampled_at DESC);

-- Per-drive temperature readings, one row per drive per sample. Backs the
-- drive-temperature carousel's history graph. Pruned at 7 days like the rest.
CREATE TABLE drive_temp_snapshots (
    id           UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    drive_id     UUID             NOT NULL REFERENCES drives (id) ON DELETE CASCADE,
    temp_celsius DOUBLE PRECISION NOT NULL,
    sampled_at   TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX drive_temp_snapshots_drive_sampled_idx
    ON drive_temp_snapshots (drive_id, sampled_at DESC);
