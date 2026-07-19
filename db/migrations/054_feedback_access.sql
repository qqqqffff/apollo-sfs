-- Add feedback form access toggle to users (default disabled — admins grant
-- access per-user from the admin Feedback → Access tab).
ALTER TABLE users ADD COLUMN IF NOT EXISTS feedback_access_enabled BOOLEAN NOT NULL DEFAULT FALSE;
