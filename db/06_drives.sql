-- Physical drives attached to a server. A server may have many drives; each
-- drive maps to its own MinIO bucket on the parent server's endpoint (or the
-- node's endpoint when node.minio_endpoint is set). All files for a user live
-- in a single drive's bucket; users are never split across drives.
-- capacity_bytes gates quota allocation — the sum of all user quotas on a drive
-- must not exceed it. drive_type records the storage medium ('nvme' or 'hdd').
-- node_id links the drive to its physical host node; NULL means unassigned.

CREATE TABLE drives (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id      UUID        NOT NULL REFERENCES servers (id),
    node_id        UUID        REFERENCES nodes (id) ON DELETE SET NULL,
    label          TEXT        NOT NULL,
    capacity_bytes BIGINT      NOT NULL,
    minio_bucket   TEXT        NOT NULL,
    is_active      BOOLEAN     NOT NULL DEFAULT true,
    drive_type     TEXT        NOT NULL DEFAULT 'hdd' CHECK (drive_type IN ('nvme', 'hdd')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT drives_server_node_bucket_key UNIQUE (server_id, node_id, minio_bucket),
    CONSTRAINT drives_server_node_label_key  UNIQUE (server_id, node_id, label)
);

CREATE INDEX drives_server_id_idx ON drives (server_id);
CREATE INDEX drives_node_id_idx   ON drives (node_id);
