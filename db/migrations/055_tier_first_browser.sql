-- Tier-first file browser (design overhaul): the file browser's root now shows
-- one entry per server & tier (drive) the user owns, every folder is bound to a
-- drive, and subfolders inherit their parent's exact drive.
--
--   1. user_preferences.default_drive_id — the drive whose view /client lands on
--      for a multi-drive user. Distinct from the upload-routing PRIMARY drive
--      (user_drive_allocations.is_primary): this is purely a display default.
--   2. folder_drive_migrations.dest_parent_id — the destination folder a user
--      picks for the enhanced "move to another server & tier" migration (NULL =
--      the destination drive's root).
--   3. Best-effort backfill of folders.drive_id so existing folders are bound to
--      a drive. NULL remains valid and is resolved to the user's PRIMARY drive
--      at read time, so this backfill is data cleanup, not a correctness
--      requirement — users who have renamed their username (so users.username no
--      longer equals folders.user_id, the Keycloak sub UUID) are intentionally
--      left NULL and handled by that read-time fallback.
--
-- Idempotent: apply-migrations.sh re-runs every file on every invocation. All
-- steps use IF NOT EXISTS / WHERE drive_id IS NULL guards so re-running is inert.

-- ── 1. user_preferences.default_drive_id ──────────────────────────────────────
ALTER TABLE user_preferences
    ADD COLUMN IF NOT EXISTS default_drive_id UUID REFERENCES drives (id) ON DELETE SET NULL;

-- ── 2. folder_drive_migrations.dest_parent_id ─────────────────────────────────
ALTER TABLE folder_drive_migrations
    ADD COLUMN IF NOT EXISTS dest_parent_id UUID REFERENCES folders (id) ON DELETE SET NULL;

-- ── 3a. Backfill top-level folders → owner's primary drive ────────────────────
-- Only matches users whose username still equals their sub UUID (never renamed);
-- for renamed users f.user_id (sub UUID) != uda.user_id (human username) so no
-- row matches and the folder is left NULL for the read-time primary fallback.
UPDATE folders f
SET drive_id = uda.drive_id
FROM user_drive_allocations uda
WHERE f.parent_id IS NULL
  AND f.drive_id IS NULL
  AND uda.is_primary = true
  AND f.user_id::text = uda.user_id;

-- ── 3b. Propagate down: each folder inherits its nearest non-null ancestor's ──
-- drive (its own concrete drive_id when it has one, else the value carried down
-- from above). Only fills folders that are still NULL, so it is a one-time
-- cleanup and safe to re-run.
WITH RECURSIVE tree AS (
    SELECT id, drive_id AS eff
    FROM folders
    WHERE parent_id IS NULL
    UNION ALL
    SELECT f.id, COALESCE(f.drive_id, t.eff)
    FROM folders f
    JOIN tree t ON f.parent_id = t.id
)
UPDATE folders f
SET drive_id = t.eff
FROM tree t
WHERE f.id = t.id
  AND f.drive_id IS NULL
  AND t.eff IS NOT NULL;

-- ── 3c. Backfill legacy root files (folder_id IS NULL) → owner's primary ──────
-- Uploads already stamp files.drive_id; this only cleans up any historical NULL.
UPDATE files f
SET drive_id = uda.drive_id
FROM user_drive_allocations uda
WHERE f.folder_id IS NULL
  AND f.drive_id IS NULL
  AND uda.is_primary = true
  AND f.user_id::text = uda.user_id;
