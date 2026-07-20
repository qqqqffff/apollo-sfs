-- File server links move from one-per-server to one-per-drive, so a user can
-- mount a server's fast (NVMe) and standard (HDD) drives as two independent
-- links instead of being limited to whichever drive Create() picked.

DROP INDEX IF EXISTS file_server_links_user_server_unique;

CREATE UNIQUE INDEX IF NOT EXISTS file_server_links_user_drive_unique
    ON file_server_links (username, drive_id);
