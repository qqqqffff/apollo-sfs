-- Onboarding guide "seen" flags, moved from browser localStorage onto the
-- account.
--
-- The base and premium spotlight tours were gated by a per-username
-- localStorage key, so anything that dropped site data — a new browser, a new
-- device, private browsing, "clear cookies and site data on close" — replayed
-- the tour on the next login. These two columns make "first login" and "first
-- time premium is active" account facts instead of browser facts.
--
-- Idempotent so it can be re-applied safely against partially-migrated
-- databases.

ALTER TABLE user_preferences
    ADD COLUMN IF NOT EXISTS onboarding_base_seen    BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS onboarding_premium_seen BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill. Every account that exists at migration time is by definition past
-- its first login, so mark the base guide seen for all of them — otherwise the
-- whole user base gets the tour replayed once on the next login after deploy,
-- which is the exact bug this migration exists to fix.
--
-- The premium guide is only marked seen for accounts premium *right now*
-- (admins included — the frontend treats is_admin as premium). A user who
-- isn't premium yet keeps the flag false so the guide still fires the first
-- time their subscription activates.
--
-- Rows are inserted for users who have never written a preference, since the
-- lazily-created-row default (FALSE) would otherwise replay the tour for them.
INSERT INTO user_preferences (user_id, onboarding_base_seen, onboarding_premium_seen, created_at, updated_at)
SELECT u.username, TRUE, (u.is_premium OR u.is_admin), NOW(), NOW()
FROM users u
ON CONFLICT (user_id) DO UPDATE
    SET onboarding_base_seen    = TRUE,
        onboarding_premium_seen = EXCLUDED.onboarding_premium_seen,
        updated_at              = NOW();
