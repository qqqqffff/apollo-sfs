-- Media collections feature.
-- Adds: folder kind, file capture-date + hidden flag, user preferences, and the
-- collection_items pointer table for subcollections.
-- Idempotent so it can be re-applied safely against partially-migrated databases.

-- ── Folder kind ────────────────────────────────────────────────────────────────
-- 'regular' (default) or 'media' (a top-level picture/video collection).
ALTER TABLE folders ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'regular';

-- ── File capture date + hidden flag ──────────────────────────────────────────
ALTER TABLE files ADD COLUMN IF NOT EXISTS taken_at TIMESTAMPTZ;
ALTER TABLE files ADD COLUMN IF NOT EXISTS hidden   BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS files_taken_at_idx ON files (folder_id, taken_at);

-- ── User preferences ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_preferences (
    user_id                    TEXT        PRIMARY KEY,
    media_autoupload_folder_id UUID        REFERENCES folders (id) ON DELETE SET NULL,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Collection item pointers ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collection_items (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL,
    collection_id UUID        NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
    file_id       UUID        NOT NULL REFERENCES files   (id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (collection_id, file_id)
);

CREATE INDEX IF NOT EXISTS collection_items_collection_id_idx ON collection_items (collection_id);
CREATE INDEX IF NOT EXISTS collection_items_file_id_idx       ON collection_items (file_id);
CREATE INDEX IF NOT EXISTS collection_items_user_id_idx       ON collection_items (user_id);
