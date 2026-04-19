-- Server metrics sampled every 5 seconds by a background goroutine.
-- network_bytes_sent and network_bytes_recv are cumulative counters since boot;
-- diff two adjacent rows over their sampled_at delta to get bytes/second.
-- storage_total_used_bytes reflects actual MinIO disk usage (filepath.Walk),
-- not the DB aggregate. Rows older than 7 days are pruned daily.

CREATE TABLE server_metrics_snapshots (
    id                        UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    cpu_percent               DOUBLE PRECISION NOT NULL,
    memory_used_bytes         BIGINT           NOT NULL,
    memory_total_bytes        BIGINT           NOT NULL,
    network_bytes_sent        BIGINT           NOT NULL,
    network_bytes_recv        BIGINT           NOT NULL,
    storage_total_used_bytes  BIGINT           NOT NULL,
    storage_total_quota_bytes BIGINT           NOT NULL,
    active_user_count         INT              NOT NULL,
    total_user_count          INT              NOT NULL,
    sampled_at                TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- Range scans and downsampled history queries filter on sampled_at.
CREATE INDEX server_metrics_snapshots_sampled_at_idx
    ON server_metrics_snapshots (sampled_at DESC);
