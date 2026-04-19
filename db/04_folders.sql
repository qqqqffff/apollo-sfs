-- Virtual folder hierarchy (PostgreSQL only; MinIO has no knowledge of it).
-- parent_id IS NULL means the folder is at the root level.
-- user_id stores the Keycloak subject UUID; it matches users.username but is
-- typed as UUID — no DB-level FK is declared across the type boundary.
-- Cascade delete removes all descendant folders when a parent is deleted;
-- files are removed by their own ON DELETE CASCADE from folders.

CREATE TABLE folders (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL,
    parent_id  UUID        REFERENCES folders (id) ON DELETE CASCADE,
    name       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT folders_unique_name_per_parent
        UNIQUE NULLS NOT DISTINCT (user_id, parent_id, name)
);

CREATE INDEX folders_user_id_idx   ON folders (user_id);
CREATE INDEX folders_parent_id_idx ON folders (parent_id);
