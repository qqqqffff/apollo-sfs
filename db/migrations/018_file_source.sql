-- Record where each file came from so the UI can show an accurate origin.
-- Complements device_id (which only identifies a mobile device): a Google
-- backup has no device but should not read as a plain "web upload".
-- Values: 'web' | 'device' | 'google_drive' | 'google_photos'.
-- Defaults to 'web' so existing rows and browser uploads are unaffected.

ALTER TABLE files
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'web';
