-- Backup reminder preference.
-- When enabled (premium/admin only — enforced by the API route group), the
-- notification bell warns the user when their most recent Google or email
-- backup is more than 30 days old. Disabled by default.
-- Idempotent so it can be re-applied safely against partially-migrated databases.

ALTER TABLE user_preferences
    ADD COLUMN IF NOT EXISTS backup_stale_notify BOOLEAN NOT NULL DEFAULT FALSE;
