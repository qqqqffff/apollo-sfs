# File Server Links (Premium WebDAV Mounts)

Premium users can generate one mount link per storage server they own capacity
on. The link (`https://apollo-sfs.com/dav/<token>`) mounts that server as a
network drive using the WebDAV protocol, which is natively supported by
Windows (Map Network Drive), macOS Finder (Connect to Server), iOS Files
(Connect to Server), Android WebDAV file managers, and Linux (GNOME Files
`davs://` or `davfs2`).

## Security model

- **The link alone grants nothing.** Every DAV request must carry HTTP Basic
  credentials, which the API verifies against Keycloak using the owner's
  normal login credentials (ROPC grant). Successful checks are cached in
  memory for 5 minutes, keyed by a SHA-256 credential hash.
- **Full file management.** `GET`/`HEAD`/`PROPFIND` (download/browse),
  `PUT`/`MKCOL` (upload, with standard overwrite semantics), `DELETE`
  (files, or folder subtrees capped at 10 000 entries), `MOVE` (rename /
  relocate files and folders, honouring the `Overwrite` header) and `COPY`
  (single files — server-side folder copies are refused; copy contents
  client-side). `PROPPATCH` is accepted and acknowledged without persisting
  dead-letter properties so Windows/macOS clients don't flag transfers as
  failed. `POST` is refused.
- **No previews, no execution — never relaxed.** Every download is served as
  `application/octet-stream` with `Content-Disposition: attachment` and
  `X-Content-Type-Options: nosniff`; file bytes are stored AES-256-GCM
  encrypted in MinIO and are only ever decrypted and streamed — never
  executed or rendered server-side. Management verbs touch only metadata
  rows and MinIO blobs.
- **Server-scoped.** The mount exposes only files stored on the link's
  server's drives; uploads and copies are hard-pinned to the owner's
  allocated drive on that server (no fallback routing), and only files on
  that server can be deleted, moved or overwritten. Folders belong to the
  user's global tree, so folder renames/moves apply account-wide, and a
  folder DELETE keeps any folder that still holds files on other servers.
- **One link per server**, enforced by a unique index. Attempting to create a
  second link returns the existing one.
- **Destroyed on premium loss or deletion.** Deleting a link removes the row
  (locations cascade); the auth middleware's premium sync and the payment
  refund path both destroy all of a user's links when premium lapses. Every
  DAV request re-resolves the token and re-checks `is_premium`, so revocation
  is immediate.

## Enhanced security mode (per-link toggle)

When enabled, uploads, downloads and destructive operations (DELETE, MOVE,
COPY) are only allowed from **verified locations** (source IPs). A request
from a new IP — or one whose verification is older than 30 days — is
rejected with 403 and a verification email is sent to the owner (throttled
to one per 10 minutes per location). The email links to
`/verify-location/<token>`; completing it requires being signed in to the
owner's account, which is the second factor. Verification tokens expire after
24 hours; verified locations stay trusted for 30 days.

## Components

| Piece | Location |
|-------|----------|
| Schema | `db/35_file_server_links.sql`, migration `db/migrations/033_file_server_links.sql` |
| DAV handler | `api/routes/dav/handler.go` + `api/routes/dav/manage.go` (registered at `/dav/:token`, outside `/api/v1`) |
| Link service | `api/routes/services/file_server_link.go` |
| Management API | `GET/POST/PATCH/DELETE /api/v1/me/file-server-links[...]`, `POST .../verify-location` |
| Verification email | `api/templates/file_server_verify_location.html` |
| nginx | `location /dav/` block in `nginx/conf.d/apollo-sfs.conf` (streamed uploads, long timeouts) |
| Frontend | Profile page card + `frontend/src/components/FileServerLinkModal.tsx` (server picker, per-device mount guide accordion, enhanced-security toggle), `frontend/src/routes/verify-location.$token.tsx` |

The creation modal shows a personalized mount guide (accordion, auto-expanded
on first link) based on the detected device OS — Windows, macOS, iOS, Android
or Linux (Ubuntu instructions), with Linux as the fallback when the device
cannot be discerned.
