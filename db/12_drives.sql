-- Physical drives attached to a server. A server may have many drives; each
-- drive maps to its own MinIO bucket on the parent server's endpoint.
-- All files for a user live in a single drive's bucket; users are never split
-- across drives. capacity_bytes is the physical drive capacity used to gate
-- quota allocation — the sum of all user quotas on a drive must not exceed it.

CREATE TABLE drives (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id      UUID        NOT NULL REFERENCES servers (id),
    label          TEXT        NOT NULL,
    capacity_bytes BIGINT      NOT NULL,
    minio_bucket   TEXT        NOT NULL,
    is_active      BOOLEAN     NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (server_id, label),
    UNIQUE (server_id, minio_bucket)
);

CREATE INDEX drives_server_id_idx ON drives (server_id);
