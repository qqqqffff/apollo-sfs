-- Per-node MinIO endpoints.
--
-- Previously the MinIO endpoint lived only on `servers`, so a server could front
-- exactly one MinIO instance and a multi-machine cluster had to be modelled as
-- several servers (one per endpoint). This made a single logical server unable to
-- span, e.g., the Pi's pooled-NVMe MinIO and the manager's HDD MinIO.
--
-- A node may now carry its own MinIO endpoint. When set, a drive mounted on that
-- node is routed to the node's endpoint; when NULL the drive falls back to the
-- parent server's endpoint (unchanged behaviour for single-instance clusters).
-- Credentials are NOT duplicated here: a node inherits its parent server's
-- (encrypted) MinIO credentials — every instance in the cluster shares the same
-- root credentials. Only the endpoint (host:port) and TLS flag differ per node.

ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS minio_endpoint TEXT,
    ADD COLUMN IF NOT EXISTS minio_use_ssl  BOOLEAN NOT NULL DEFAULT false;
