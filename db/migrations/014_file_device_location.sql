-- Attach the uploading device and GPS coordinates to each file.
-- device_id is nullable — files uploaded from the web have no device row.
-- latitude/longitude are nullable — only images with GPS EXIF tags are populated.

ALTER TABLE files
    ADD COLUMN IF NOT EXISTS device_id  UUID             REFERENCES devices (id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS latitude   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS longitude  DOUBLE PRECISION;
