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

-- Backfill: give every existing server a default "manager" node named after the
-- server, and attach that server's drives to it so the metrics view is populated.
INSERT INTO nodes (server_id, hostname, role)
SELECT s.id, s.name || '-node-1', 'manager'
FROM servers s
WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.server_id = s.id);

UPDATE drives d
SET node_id = n.id
FROM nodes n
WHERE n.server_id = d.server_id
  AND d.node_id IS NULL;
