-- Admin "Edit role" + "Delete user" feature (admin Users page):
--   * users.premium_expires_at / premium_purchase_blocked — an admin-granted
--     Premium "trial" expiry (null = permanent) and an opt-in block on future
--     Premium purchases after a demotion, independent of real PayPal billing.
--   * role_change_notifications — one row per admin role assignment, feeding
--     the affected user's notification bell with the admin's reason (mirrors
--     quota_change_notifications, migration 046).
--   * FK fixes on user_drive_allocations / server_expansion_requests so a full
--     account deletion (DELETE FROM users) no longer fails on a leftover row —
--     migration 036 deliberately left these NO ACTION on delete ("a user's
--     allocations must be released explicitly"); admin-initiated account
--     deletion is exactly that explicit release.

-- ── users.premium_expires_at / premium_purchase_blocked ───────────────────────
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS premium_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS premium_purchase_blocked BOOLEAN NOT NULL DEFAULT FALSE;

-- ── role_change_notifications ─────────────────────────────────────────────────
-- username uses ON UPDATE CASCADE / ON DELETE CASCADE for the same reason as
-- quota_change_notifications: a live notification-bell source looked up by
-- the affected user's *current* username on every GET /me/notifications call.
CREATE TABLE IF NOT EXISTS role_change_notifications (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    username             TEXT        NOT NULL REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE,
    changed_by           TEXT        NOT NULL,
    previous_role        TEXT        NOT NULL,
    new_role             TEXT        NOT NULL,
    reason               TEXT        NOT NULL,
    premium_expires_at   TIMESTAMPTZ,
    block_future_premium BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS role_change_notifications_username_idx
    ON role_change_notifications (username, created_at DESC);

-- ── FK fixes for full account deletion ────────────────────────────────────────
ALTER TABLE user_drive_allocations DROP CONSTRAINT IF EXISTS user_drive_allocations_user_id_fkey;
ALTER TABLE user_drive_allocations
    ADD CONSTRAINT user_drive_allocations_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE server_expansion_requests DROP CONSTRAINT IF EXISTS server_expansion_requests_username_fkey;
ALTER TABLE server_expansion_requests
    ADD CONSTRAINT server_expansion_requests_username_fkey
    FOREIGN KEY (username) REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE;
