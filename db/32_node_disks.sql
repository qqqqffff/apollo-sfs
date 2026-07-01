-- Physical-disk telemetry, decoupled from logical drives. A logical `drive` is a
-- MinIO bucket on an endpoint; with a pooled MinIO one drive can span several
-- physical disks, so per-disk health lives here instead. The node agent reports
-- each labelled disk every sample (api/cmd/node-agent), independent of whether it
-- backs a registered drive — so one disk in a pool failing or running hot is
-- visible on its own.
--
-- node_disks holds each disk's latest state, upserted per (node, label).
-- node_disk_temp_snapshots holds the temperature time-series for the per-disk
-- history graph (mirrors drive_temp_snapshots). Both pruned at 7 days.

CREATE TABLE node_disks (
    id             UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id        UUID             NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    label          TEXT             NOT NULL,
    device         TEXT             NOT NULL DEFAULT '',
    capacity_bytes BIGINT           NOT NULL DEFAULT 0,
    used_bytes     BIGINT           NOT NULL DEFAULT 0,
    free_bytes     BIGINT           NOT NULL DEFAULT 0,
    temp_celsius   DOUBLE PRECISION,
    last_seen_at   TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    created_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    UNIQUE (node_id, label)
);

CREATE INDEX node_disks_node_id_idx ON node_disks (node_id);

CREATE TABLE node_disk_temp_snapshots (
    id           UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    disk_id      UUID             NOT NULL REFERENCES node_disks (id) ON DELETE CASCADE,
    temp_celsius DOUBLE PRECISION NOT NULL,
    sampled_at   TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX node_disk_temp_snapshots_disk_sampled_idx
    ON node_disk_temp_snapshots (disk_id, sampled_at DESC);
