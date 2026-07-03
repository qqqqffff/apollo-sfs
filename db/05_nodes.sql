-- Storage nodes that make up a server's Docker Swarm cluster. A "server" is the
-- host that manages the cluster and runs the webserver/app infrastructure; each
-- server owns one or more nodes (the manager host itself plus any worker/storage
-- nodes) joined to the same Swarm network. Physical drives are mounted on a node,
-- so the topology is server → node → drive.
--
-- role classifies what the node does in the swarm:
--   'manager' — runs the control plane + app stack (usually the server host)
--   'worker'  — a swarm worker that may also carry storage
--   'storage' — a worker dedicated to holding drives (fast/standard tiers)
-- hostname matches the node's Docker Swarm hostname (e.g. "apollo-sfs-1").
-- address is the node's advertised LAN/WireGuard address used to join the swarm.
--
-- minio_endpoint optionally overrides the parent server's MinIO endpoint, so one
-- logical server can span multiple MinIO instances (one per machine). A drive
-- mounted on a node with its own endpoint is routed there; a NULL endpoint falls
-- back to the server's. Credentials are inherited from the parent server (every
-- instance shares the same root credentials), so only the endpoint + TLS flag
-- live here.

CREATE TABLE nodes (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id      UUID        NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    hostname       TEXT        NOT NULL,
    role           TEXT        NOT NULL DEFAULT 'worker',
    address        TEXT        NOT NULL DEFAULT '',
    minio_endpoint TEXT,
    minio_use_ssl  BOOLEAN     NOT NULL DEFAULT false,
    is_active      BOOLEAN     NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (server_id, hostname)
);

CREATE INDEX nodes_server_id_idx ON nodes (server_id);
