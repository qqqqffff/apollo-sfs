-- Admin "Edit storage" feature (per-user, multi-allocation storage editor):
--   * user_drive_allocations.quota_bytes — per-drive quota, backfilled from
--     users.storage_quota_bytes so real per-drive upload enforcement can
--     replace the old aggregate-only check
--   * audit_logs.details — structured, expandable JSON detail for audit
--     entries that need more than the flat resource_name (the allocation
--     editor's before/after breakdown + admin reason)
--   * quota_change_notifications — one row per admin allocation-editor save,
--     feeding the affected user's notification bell "Breakdown" button

-- ── user_drive_allocations.quota_bytes ────────────────────────────────────────
ALTER TABLE user_drive_allocations
    ADD COLUMN IF NOT EXISTS quota_bytes BIGINT NOT NULL DEFAULT 0;

-- Backfill: a user's PRIMARY allocation gets their full aggregate quota, since
-- it is (as of this migration) their only allocation in virtually every case —
-- AddUserDrive, the only code path that would ever create a second,
-- non-primary allocation, has never been called in production. Any
-- pre-existing non-primary row (none expected) is left at the column default
-- of 0 and is inert until an admin explicitly assigns it a quota via the new
-- editor (a 0-quota allocation never wins a per-drive upload-routing check).
--
-- `AND uda.quota_bytes = 0` makes this a ONE-TIME backfill despite
-- apply-migrations.sh re-running every file on every invocation forever (no
-- migrations-tracking table exists — see its header comment). Without this
-- guard, re-running after the feature has shipped and an admin has edited a
-- multi-drive user's allocations would stomp the primary row's own
-- quota_bytes back to users.storage_quota_bytes — which by then is the SUM
-- across every one of that user's allocations, not just the primary's share.
-- Once a row's quota_bytes is non-zero (set here, by the new admin editor, or
-- by AllocateUserToDrive/AddUserQuotaAndAllocation), further re-runs skip it.
UPDATE user_drive_allocations uda
SET quota_bytes = u.storage_quota_bytes
FROM users u
WHERE uda.user_id = u.username
  AND uda.is_primary = true
  AND uda.quota_bytes = 0;

-- ── audit_logs.details ────────────────────────────────────────────────────────
-- Nullable; unused by every pre-existing action. Only the new
-- "storage_allocations_updated" action populates it.
ALTER TABLE audit_logs
    ADD COLUMN IF NOT EXISTS details JSONB;

-- ── quota_change_notifications ────────────────────────────────────────────────
-- username uses ON UPDATE CASCADE / ON DELETE CASCADE (mirrors
-- dismissed_notifications) because this table is a *live* notification-bell
-- source looked up by the affected user's *current* username on every
-- GET /me/notifications call — unlike audit_logs (an immutable historical
-- record that intentionally has no FK and does not follow renames), this
-- table would silently stop matching after a rename without cascade.
-- changed_by (the acting admin) is plain, unconstrained TEXT — mirrors
-- audit_logs.actor_username, which is never used as a join/lookup key.
CREATE TABLE IF NOT EXISTS quota_change_notifications (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    username   TEXT        NOT NULL REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE,
    changed_by TEXT        NOT NULL,
    reason     TEXT,
    details    JSONB       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS quota_change_notifications_username_idx
    ON quota_change_notifications (username, created_at DESC);
