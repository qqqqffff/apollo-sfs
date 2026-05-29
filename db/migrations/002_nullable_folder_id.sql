-- Allow files to exist at the root level (no containing folder).
-- The original NOT NULL constraint and table-level unique index are replaced
-- with two partial unique indexes that handle the NULL folder_id case correctly
-- (NULL != NULL in SQL, so a table UNIQUE constraint silently allows duplicates
-- when folder_id is NULL).

ALTER TABLE files ALTER COLUMN folder_id DROP NOT NULL;

-- Drop the original unique constraint (name may vary depending on Postgres version).
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_unique_name_per_folder;

-- Unique filename per folder for non-root files.
CREATE UNIQUE INDEX IF NOT EXISTS files_unique_name_per_folder
    ON files (user_id, folder_id, name)
    WHERE folder_id IS NOT NULL;

-- Unique filename at root level (folder_id IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS files_unique_name_at_root
    ON files (user_id, name)
    WHERE folder_id IS NULL;
