-- Usernames and emails are case-insensitive identities: Keycloak stores both
-- lower-cased and puts the lower-cased form in every token, so an app row that
-- kept the case the user typed ("Zoe" / "Zoe@x.com") was never found again and
-- the next login provisioned a second row ("zoe" / "zoe@x.com").
-- See docs/duplicate_accounts.md.
--
--   1. premium_subscriptions.username was the one FK to users without ON UPDATE
--      CASCADE (036 predates the table). Renaming anybody who had ever
--      subscribed therefore succeeded in Keycloak and then failed here, leaving
--      the two out of sync — and the next login duplicated the account.
--   2. user_account_merges records every reconciled duplicate, with a snapshot
--      of the row that was removed (wrapped key included) so a bad merge can be
--      undone by hand.
--   3. Case-insensitive unique indexes, so a duplicate can't be created again
--      by any code path. They can't be built while duplicates exist, so this
--      file only creates them on an already-clean database; on one that still
--      has duplicates the reconciliation run creates them once it has finished
--      (db.Queries.EnsureUserIdentityIndexes).
--
-- Idempotent: apply-migrations.sh re-runs every file on every invocation.

-- ── 1. premium_subscriptions FK ───────────────────────────────────────────────
ALTER TABLE premium_subscriptions DROP CONSTRAINT IF EXISTS premium_subscriptions_username_fkey;
ALTER TABLE premium_subscriptions
    ADD CONSTRAINT premium_subscriptions_username_fkey
    FOREIGN KEY (username) REFERENCES users (username) ON UPDATE CASCADE ON DELETE CASCADE;

-- ── 2. Merge ledger ───────────────────────────────────────────────────────────
-- Plain-text usernames on purpose: the merged row is gone by definition, and
-- the ledger has to outlive the survivor too.
CREATE TABLE IF NOT EXISTS user_account_merges (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    survivor_username TEXT        NOT NULL,
    merged_username   TEXT        NOT NULL,
    merged_by         TEXT        NOT NULL,
    snapshot          JSONB       NOT NULL,  -- to_jsonb(users.*) of the removed row
    allocations       JSONB       NOT NULL DEFAULT '[]'::jsonb, -- its drive allocations
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_account_merges_survivor_idx
    ON user_account_merges (survivor_username, created_at DESC);

-- ── 3. Case-insensitive uniqueness ────────────────────────────────────────────
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM users GROUP BY LOWER(username) HAVING COUNT(*) > 1)
    OR EXISTS (SELECT 1 FROM users GROUP BY LOWER(email)    HAVING COUNT(*) > 1) THEN
        RAISE NOTICE 'users has duplicate accounts - reconcile them on the admin Users page; the unique indexes are created when that finishes';
    ELSE
        CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username));
        CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx    ON users (LOWER(email));
    END IF;
END $$;
