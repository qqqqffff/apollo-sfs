-- Virtual folder hierarchy (PostgreSQL only; MinIO has no knowledge of it).
-- parent_id IS NULL means the folder is at the root level.
-- user_id stores the Keycloak subject UUID; it matches users.username but is
-- typed as UUID — no DB-level FK is declared across the type boundary.
-- Cascade delete removes all descendant folders when a parent is deleted;
-- files are removed by their own ON DELETE CASCADE from folders.

-- kind distinguishes a normal folder ('regular') from a media collection
-- ('media'). A media folder is a top-level picture/video collection; any folder
-- nested beneath it acts as a subcollection.
CREATE TABLE folders (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL,
    parent_id  UUID        REFERENCES folders (id) ON DELETE CASCADE,
    name       TEXT        NOT NULL,
    kind       TEXT        NOT NULL DEFAULT 'regular',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT folders_unique_name_per_parent
        UNIQUE NULLS NOT DISTINCT (user_id, parent_id, name)
);

CREATE INDEX folders_user_id_idx   ON folders (user_id);
CREATE INDEX folders_parent_id_idx ON folders (parent_id);

-- Row-level security: queries must run inside a transaction that sets
-- app.current_user_id to the requesting user's UUID via db.Queries.ForUser().
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE folders FORCE  ROW LEVEL SECURITY;

CREATE POLICY folders_owned_by_current_user ON folders
    USING      (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
