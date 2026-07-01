-- Collection item pointers: a many-to-many link placing a file into a media
-- subcollection without moving its physical home (files.folder_id is unchanged).
-- This backs the "copy into subcollection" action — the same file can appear in
-- the parent media folder's grid and in one or more subcollections at once.
--
-- collection_id references the subcollection folder; file_id the pointed file.
-- user_id scopes rows at the application layer (mirrors the favorites table).
-- Cascade deletes remove pointers when either the subcollection or file is gone.

CREATE TABLE collection_items (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL,
    collection_id UUID        NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
    file_id       UUID        NOT NULL REFERENCES files   (id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (collection_id, file_id)
);

CREATE INDEX collection_items_collection_id_idx ON collection_items (collection_id);
CREATE INDEX collection_items_file_id_idx       ON collection_items (file_id);
CREATE INDEX collection_items_user_id_idx       ON collection_items (user_id);
