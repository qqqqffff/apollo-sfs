-- Node-scoped uniqueness for drives.
--
-- The infrastructure sync now models the whole deployment as ONE cluster server
-- with the standard tier as a node-level MinIO endpoint override (see
-- 023_node_minio_endpoints.sql). Under that single server there is one drive per
-- tier — a fast drive on the Pi node and a standard drive on the manager node —
-- and both MinIO instances expose the same configured bucket name. The original
-- `UNIQUE (server_id, minio_bucket)` / `UNIQUE (server_id, label)` constraints
-- (db/12_drives.sql) would reject the second tier's drive on that collision.
--
-- Re-key uniqueness on (server_id, node_id, ...) so each node may host its own
-- drive for the shared bucket name. Tier drives always carry a non-null node_id,
-- so this enforces exactly one drive per (node, bucket) / (node, label). The
-- (server_id, node_id, minio_bucket) index also backs the sync's UpsertDrive
-- ON CONFLICT target.

ALTER TABLE drives DROP CONSTRAINT IF EXISTS drives_server_id_minio_bucket_key;
ALTER TABLE drives DROP CONSTRAINT IF EXISTS drives_server_id_label_key;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'drives_server_node_bucket_key'
    ) THEN
        ALTER TABLE drives
            ADD CONSTRAINT drives_server_node_bucket_key
            UNIQUE (server_id, node_id, minio_bucket);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'drives_server_node_label_key'
    ) THEN
        ALTER TABLE drives
            ADD CONSTRAINT drives_server_node_label_key
            UNIQUE (server_id, node_id, label);
    END IF;
END $$;
