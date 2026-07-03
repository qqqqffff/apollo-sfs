-- Server metrics sampled every 5 seconds by a background goroutine.
-- network_bytes_sent and network_bytes_recv are cumulative counters since boot;
-- diff two adjacent rows over their sampled_at delta to get bytes/second.
-- storage_total_used_bytes reflects actual MinIO disk usage (filepath.Walk),
-- not the DB aggregate. Rows older than 7 days are pruned daily.
-- Temperature columns are nullable: servers lacking accessible sensors omit them.
-- server_isp_ping_ms / server_isp_packet_loss_percent are nullable: populated
-- when ICMP targets are reachable; NULL when ping is unavailable.
-- speed_test_* columns store the most recent bandwidth test result; NULL until
-- the first test completes.

CREATE TABLE server_metrics_snapshots (
    id                              UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    cpu_percent                     DOUBLE PRECISION NOT NULL,
    memory_used_bytes               BIGINT           NOT NULL,
    memory_total_bytes              BIGINT           NOT NULL,
    network_bytes_sent              BIGINT           NOT NULL,
    network_bytes_recv              BIGINT           NOT NULL,
    storage_total_used_bytes        BIGINT           NOT NULL,
    storage_total_quota_bytes       BIGINT           NOT NULL,
    active_user_count               INT              NOT NULL,
    total_user_count                INT              NOT NULL,
    disk_total_bytes                BIGINT           NOT NULL DEFAULT 0,
    disk_free_bytes                 BIGINT           NOT NULL DEFAULT 0,
    cpu_temp_celsius                DOUBLE PRECISION,
    drive_temp_celsius              DOUBLE PRECISION,
    server_isp_ping_ms              DOUBLE PRECISION,
    server_isp_packet_loss_percent  DOUBLE PRECISION,
    speed_test_upload_mbps          DOUBLE PRECISION,
    speed_test_download_mbps        DOUBLE PRECISION,
    speed_test_tested_at            TIMESTAMPTZ,
    sampled_at                      TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- Range scans and downsampled history queries filter on sampled_at.
CREATE INDEX server_metrics_snapshots_sampled_at_idx
    ON server_metrics_snapshots (sampled_at DESC);
