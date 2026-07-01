-- Introduce the storage-node layer between servers and drives.
-- A server is the cluster manager + app host; it owns one or more nodes (joined
-- to the same Docker Swarm network) and each physical drive is mounted on a node.
-- See db/28_nodes.sql for the full column documentation.

CREATE TABLE IF NOT EXISTS nodes (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id  UUID        NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    hostname   TEXT        NOT NULL,
    role       TEXT        NOT NULL DEFAULT 'worker',
    address    TEXT        NOT NULL DEFAULT '',
    is_active  BOOLEAN     NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (server_id, hostname)
);

CREATE INDEX IF NOT EXISTS nodes_server_id_idx ON nodes (server_id);

ALTER TABLE drives
    ADD COLUMN IF NOT EXISTS node_id UUID REFERENCES nodes (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS drives_node_id_idx ON drives (node_id);

-- No data backfill: this migration only adds structure. Nodes and drive->node
-- assignments are established by the infrastructure sync / admin actions, so
-- re-running never alters existing rows.
