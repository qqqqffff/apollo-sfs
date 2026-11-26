# Duplicate accounts: cause, prevention, and reconciliation

## What went wrong

Keycloak stores usernames and emails **lower-cased** and puts the lower-cased
form in every token (`preferred_username`, `email`). The app's `users` table
compared them **case-sensitively**, so a row that didn't match Keycloak's
spelling exactly was invisible to every request, and the next password login
(`AuthService.ensureUserProvisioned`) created a second row: a fresh encryption
key, the 10 GB placeholder quota, and no drive allocation.

Two paths produced such a row:

1. **Registration with capitals.** `Register` stored the username/email as
   typed (phone keyboards capitalise the first letter: `Zoe` / `Zoe@x.com`).
   Its own auto-login then provisioned `zoe` / `zoe@x.com`. The invitation's
   grants (quota, drive, premium trial expiry) stayed on `Zoe`, which nothing
   ever read again, so the trial never lapsed. `ListExpiredPremiumGrants` needs
   `is_premium`, which only the token-matched row ever got.
2. **Renaming a (former) subscriber.** `premium_subscriptions.username` was the
   one FK to `users` without `ON UPDATE CASCADE`. `RenameUser` renamed the user
   in Keycloak, then the DB update failed on that FK, leaving the app row under
   the old name with the original-case email. The next login provisioned a
   row under the new name. That is why the duplicate showed up around a premium
   subscription ending: the old row, holding the subscription, files and
   original-case email, drops to a regular user while the new row is the one
   the person actually uses.

A related bug: invitations and registration slots grant the `premium` realm
role **directly**, while trial expiry only removed the `premium` **group**.
The role stayed in the user's tokens, so the auth middleware turned
`is_premium` back on with the next request.

## Prevention (migration 065 + code)

- Usernames and emails are canonicalised to lower case wherever they're stored
  (`sanitize.Username` / `sanitize.Email`, `CreateUser`, `Register*`,
  invitations, `RenameUser`).
- Login resolves the app row case-insensitively (`AuthService.resolveAppUser`)
  and **heals** a mismatched row by renaming it to Keycloak's spelling instead
  of creating a new one. A row left behind by a half-finished rename (same
  email, old username no longer in Keycloak, verified email) is adopted the same
  way. An email that belongs to a *different* live Keycloak account is refused.
- `RenameUser` reverts the Keycloak rename if the DB update fails, and
  `UpdateUsername` also carries the username columns that have no FK
  (`audit_logs`, `user_preferences`, …).
- `premium_subscriptions.username` now cascades on update.
- Premium revocation removes both the group and a directly mapped role.
- Case-insensitive unique indexes `users_username_lower_idx` /
  `users_email_lower_idx` make a duplicate impossible. 065 only creates them on
  a database without duplicates; otherwise the reconciliation run below creates
  them when it finishes.
- Admin **Delete user** refuses to delete one of a duplicate pair: Keycloak
  looks usernames up ignoring case, so it would delete the real account's login.

## Reconciling existing duplicates

Admin → Users shows a banner when any exist. **Review** lists each group:

| Action | Meaning |
|--------|---------|
| merge | Several rows are one person (same username or email, ignoring case). |
| normalize | One row stored with capitals; it's renamed/lower-cased in place. |

The row marked **keep** is the one already spelled the way Keycloak spells it
(so live sessions and their encryption key are unaffected), else the most
recently active. **Reconcile** (`POST /admin/users/duplicates/reconcile`) runs in
the background; the modal polls `GET /admin/users/duplicates`.

For each group, `UserReconcileService`:

1. Confirms all rows map to **one** Keycloak login (`LookupIdentity`). No login,
   or more than one, makes the group a *blocker*: it's left for a person.
   So does more than one live premium subscription.
2. **Re-encrypts** every blob sealed with a merged row's key under the kept
   row's key (`FileService.RekeyUserObjects`): files, ready video variants,
   recognition crops. Chunked videos are streamed chunk by chunk, keeping their
   layout. Each copy is written to a new object, the row is re-pointed, then the
   old object is deleted. Blobs no candidate key opens are left untouched and
   reported.
3. **Merges** in one transaction (`db.Queries.MergeUsers`): re-points every
   per-user row (FK and non-FK username columns), combines drive allocations
   (same drive → quotas added), sums usage, keeps the kept row's role flags,
   carries over a stranded trial expiry, snapshots each removed row (including
   its wrapped key and allocations) into `user_account_merges`, deletes it, and
   renames the survivor to Keycloak's spelling. It refuses to delete a row any
   FK table still references, so a table added later without updating
   `db/user_merge.go` can't silently lose rows
   (`TestIntegrationUserRefsCoverSchema` also catches that in CI).
4. Writes an `account_merged` / `account_normalized` audit entry.

**Quota:** a row with drive allocations contributes its whole quota. A row
without any (the auto-provisioned half) contributes only what was bought above
the 10 GB placeholder. Both halves' quotas were already committed against
drive capacity, so the sum never over-commits. Adjust afterwards with the
storage allocation editor if needed.

Re-running is safe. Already-re-keyed blobs are recognised as current, and a
group that failed (e.g. MinIO unreachable) is simply retried.

**Undoing a merge** is manual. `user_account_merges.snapshot` holds the removed
row (`to_jsonb(users.*)`; `encrypted_key` is wrapped under the master key
version recorded alongside it, which stays decryptable until that version is
purged by rotation) and `allocations` its drive allocations.

**Known limit:** a video variant whose parent file was later moved to another
drive (drive migrations don't move variants) isn't found under the parent's
drive and is reported as *missing*. If it was under the merged row's key, its
low-quality stream won't play; the original still does.
