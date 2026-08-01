# Email Backup Setup

The email backup feature (premium) lets a user sign into a Gmail or
Microsoft/Outlook account, pick messages with filters (sender, date range,
starred/flagged, unread, attachments, text search), and back them up into
Apollo SFS. Each message is stored as an encrypted file — quota and per-drive
enforcement apply exactly like normal uploads — inside a dedicated root folder
of kind `email` whose name is the email address (shown with an `@` icon).
Opening that folder renders a mail viewer (sender sidebar → message list →
reading pane, the same panel family as the admin service-email console).

## Architecture

- **Provider OAuth is entirely client-side** (same pattern as the Google
  Drive/Photos backup): the browser fetches messages from the provider API and
  posts them to the backend one at a time. The server never sees provider
  tokens.
- **Retrieval streams into the picker.** After the retrieval criteria is
  chosen, `listProviderMessages` pages the mailbox 200 messages at a time and
  hands each page to the picker as it lands (`onPage`), so the table fills in
  and can be filtered while the rest is still downloading. A progress strip at
  the top of the modal shows the count, a percentage against the chosen
  criteria (`fetchProgressFor`), and a **Stop** button (`shouldStop`) that ends
  paging early and keeps what has arrived. The **Back Up** button stays
  disabled until retrieval finishes or is stopped.
- **Selection is global, not per-filter.** Everything is selected by default
  (including messages that stream in later, until the user makes a choice of
  their own). "All" adds the rows the current filter shows; "None" clears the
  *entire* selection — clearing only the visible rows used to leave
  filtered-out messages selected and silently in the backup. Any selected
  message the filter hides is called out with a "…hidden by the current
  filters" notice and a one-click Deselect.
- **Backend** (`api/routes/email_backup.go`, `services/email_backup.go`):
  - `POST /email-backup/folders` — get-or-create the backup folder for an
    address, optionally pinned to a drive (`drive_id`). Existing folders keep
    their pin.
  - `POST /email-backup/messages` — store one message (encrypted file +
    `email_backup_messages` index row). 409 = already backed up (dedupe on
    `(folder_id, provider_message_id)`), 413 = quota exceeded, 507 = pinned
    drive unavailable. The response carries `file_name` and `file_size_bytes`
    (response-only fields on `models.EmailBackupMessage`) so a running backup
    can show the file it just wrote and credit the quota bar without re-reading
    the folder.
  - `GET /email-backup/folders/:id/senders|messages`,
    `GET/PATCH/DELETE /email-backup/messages/:id` — viewer endpoints; the
    detail endpoint decrypts the backing file on demand.
  - `POST /email-backup/runs` — records a completed run; with `notify: true`
    it surfaces in the notification bell (`email_backup_completed` kind).
  - All under the premium route group.
- **Schema**: `db/migrations/050_email_backup.sql`
  (`email_backup_messages` with RLS, `email_backup_runs`).

## Optional settings (picker → Settings tab)

- **Storage location** — tier (fast/standard) + server picker; sets the backup
  folder's `drive_id` on first creation.
- **Delete emails after backup** — moves each successfully backed-up message
  to the provider's trash (Gmail trash / Outlook Deleted Items). Skipped when a
  cancelled run's partial backup was rolled back — the copies that would have
  justified trashing the originals are gone.
- **Notify me when the backup completes** — bell notification with counts.
- **Back up in the background** — closes the picker and keeps uploading, with
  the run shown on the toolbar card (see below).

## Running a backup (shared with the Google backup)

Both flows run the same sequential per-item loop and the same controls, whether
in the picker window or on the background toolbar card
(`frontend/src/api/backupControl.ts`, `components/BackupProgress.tsx`,
`hooks/useBackgroundBackup.ts`):

- **Pause / Resume** — the loop awaits `control.gate()` before each item, so a
  pause takes effect at the next item; whatever is already in flight finishes
  rather than leaving a half-written object server-side.
- **Cancel** — pauses the run and opens a confirmation
  (`components/BackupCancelModal.tsx`) with two outcomes for the part that
  already landed: **remove what was backed up** (deletes those files —
  `removeBackedUpMessages` / `removeBackedUpFiles` — and frees the storage
  again) or **keep them**. Resuming from the dialog is the escape hatch for a
  mis-click. The run record logged afterwards counts only what was kept.
- **Live progress** — as each file/email lands, its bytes are credited to the
  quota bar and the drive's bar straight away from the upload response, and the
  file listing is refreshed (coalesced to ~1.5 s) so items appear in the
  browser as they arrive (`hooks/useBackupLiveSync.ts`). Under the progress bar
  the card shows the destination of the item in flight as a full path
  (`user@example.com/2026-07-01 Subject [ab12cd34].email.json`) and the running
  total against the size of the whole backup. Everything is reconciled against
  the server once the run ends.

Both flows hit one endpoint per item, which is why uploads, the dedupe probe,
per-item deletes and the email-backup endpoints are on the API's higher
per-user bulk rate-limit budget rather than the standard per-IP one (see
`api/routes/middleware/rate_limit.go`); the frontend also retries a 429 with
backoff (`frontend/src/api/client.ts`).

## Gmail

Uses the existing Google Identity Services web client
(`GOOGLE_CLIENT_ID` in `frontend/src/api/googleBackup.ts`). The Gmail flow
requests the `https://www.googleapis.com/auth/gmail.modify` scope (read +
trash; needed for "delete after backup"). Add that scope to the OAuth consent
screen in the Google Cloud console and enable the **Gmail API** for the
project.

## Microsoft / Outlook

Requires an Azure AD app registration:

1. Azure Portal → App registrations → New registration.
2. Supported account types: *Accounts in any organizational directory and
   personal Microsoft accounts*.
3. Add a **Single-page application** redirect URI:
   `https://<your-domain>/ms-oauth.html` (and
   `http://localhost:5173/ms-oauth.html` for dev). The SPA platform type is
   what allows the CORS token exchange used by the PKCE popup flow.
4. API permissions → Microsoft Graph → Delegated: `User.Read`,
   `Mail.ReadWrite` (ReadWrite is needed for "delete after backup").
5. Put the Application (client) ID in the **root `.env`** (alongside the other
   deployment secrets):

```
VITE_MS_CLIENT_ID=<application-client-id>
```

Vite inlines `VITE_*` variables at build time, so the value is baked into the
frontend image: `deploy.sh` sources `.env` and passes it to the image build as
`--build-arg VITE_MS_CLIENT_ID=…` (see `frontend/Dockerfile`). Rebuild/redeploy
the frontend after changing it. For local dev (`npm run dev`), export the
variable in your shell or a local Vite env file.

The Microsoft option in the provider picker reports a clear error when the
variable is unset; Gmail keeps working without it.

> The same Azure app registration can also back the **Sign in with Microsoft**
> Keycloak identity provider — see `keycloak/KC_setup.md` §4. The Keycloak
> broker redirect URI goes on a **Web** platform (with client secret), while
> this feature's `/ms-oauth.html` URI goes on a **Single-page application**
> platform.

## Files

| Area | Files |
|------|-------|
| Backend | `api/routes/email_backup.go`, `api/routes/services/email_backup.go`, `api/db/email_backup.go`, `api/models/email_backup.go` |
| Migration | `db/migrations/050_email_backup.sql` |
| Provider layer | `frontend/src/api/emailProviders.ts`, `frontend/public/ms-oauth.html` |
| Backend client | `frontend/src/api/emailBackup.ts`, `frontend/src/types/emailBackup.ts` |
| UI | `frontend/src/components/EmailProviderSelectModal.tsx`, `EmailRetrievalCriteriaModal.tsx`, `EmailBackupModal.tsx`, `EmailBackupView.tsx` |
| Run controls (shared with the Google backup) | `frontend/src/api/backupControl.ts`, `components/BackupProgress.tsx`, `components/BackupCancelModal.tsx`, `hooks/useBackgroundBackup.ts`, `hooks/useBackupLiveSync.ts` |
