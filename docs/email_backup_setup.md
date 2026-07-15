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
- **Backend** (`api/routes/email_backup.go`, `services/email_backup.go`):
  - `POST /email-backup/folders` — get-or-create the backup folder for an
    address, optionally pinned to a drive (`drive_id`). Existing folders keep
    their pin.
  - `POST /email-backup/messages` — store one message (encrypted file +
    `email_backup_messages` index row). 409 = already backed up (dedupe on
    `(folder_id, provider_message_id)`), 413 = quota exceeded, 507 = pinned
    drive unavailable.
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
  to the provider's trash (Gmail trash / Outlook Deleted Items).
- **Notify me when the backup completes** — bell notification with counts.

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
| UI | `frontend/src/components/EmailProviderSelectModal.tsx`, `EmailBackupModal.tsx`, `EmailBackupView.tsx` |
