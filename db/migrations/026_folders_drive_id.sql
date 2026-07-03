-- Optional per-folder drive pin: when set, uploads into this folder prefer
-- this drive (subject to it still being active/owned/having room) instead of
-- the dynamic primary-first/least-full routing. NULL preserves today's
-- behavior exactly. Mirrors the existing per-file drive_id pattern (11_files.sql)
-- applied one level up, at the folder level, as an upload-routing hint.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'folders' AND column_name = 'drive_id'
    ) THEN
        ALTER TABLE folders ADD COLUMN drive_id UUID REFERENCES drives (id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS folders_drive_id_idx ON folders (drive_id);
