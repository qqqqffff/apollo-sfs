# File Server Links (Premium WebDAV Mounts)

Premium users can generate one mount link per **drive** — a single server +
storage tier (fast/NVMe or standard/HDD) — they own capacity on. A server
that exposes both tiers to a user yields two independently mountable links,
one per drive. The link (`https://apollo-sfs.com/dav/<token>`) mounts that
drive as a network drive using the WebDAV protocol, which is natively
supported by Windows (Map Network Drive), macOS Finder (Connect to Server),
iOS Files (Connect to Server), Android WebDAV file managers, and Linux
(GNOME Files `davs://` or `davfs2`).

The token is human-readable — `<server-slug>-<tier>-<8 random chars>`, e.g.
`attic-fast-a3k9zq2m` — rather than an opaque blob, since it's what the user
sees as the network location once mounted (Explorer's drive properties,
Finder's sidebar, `net use` output, etc.). It isn't a bearer secret on its
own: the random suffix (36^8 combinations) only needs to avoid collisions,
since every DAV request still requires the owner's login credentials
regardless of what the token looks like.

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
- **Drive-scoped.** The mount exposes only files stored on the link's exact
  drive (not other drives/tiers on the same server); uploads and copies are
  hard-pinned to that drive (no fallback routing), and only files on it can
  be deleted, moved or overwritten. Folders belong to the user's global tree,
  so folder renames/moves apply account-wide, and a folder DELETE keeps any
  folder that still holds files on other drives.
- **One link per drive**, enforced by a unique index on (username, drive_id).
  Attempting to create a second link for the same drive returns the existing
  one; a server exposing both a fast and standard tier to a user allows one
  link per tier.
- **Reported capacity matches the user's quota on the drive.** The mount root
  reports RFC 4331 `quota-used-bytes`/`quota-available-bytes` computed from
  the user's own per-drive `quota_bytes` allocation and their own usage on it
  (the same figures the storage page shows and that upload enforcement gates
  against) — never the drive's shared physical capacity, which other users'
  data also lives on. This means a fast-tier and standard-tier mount on the
  same server correctly show different capacities in Windows/macOS drive
  properties instead of both echoing one account-wide number, and the
  reported free space always matches what the mount will actually accept
  before returning 507.
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
| Schema | `db/35_file_server_links.sql`, migrations `db/migrations/033_file_server_links.sql` (initial) + `044_file_server_links_per_drive.sql` (per-drive unique index) |
| DAV handler | `api/routes/dav/handler.go` + `api/routes/dav/manage.go` (registered at `/dav/:token`, outside `/api/v1`) |
| Link service | `api/routes/services/file_server_link.go` |
| Management API | `GET/POST/PATCH/DELETE /api/v1/me/file-server-links[...]`, `POST .../verify-location` |
| Verification email | `api/templates/file_server_verify_location.html` |
| nginx | `location /dav/` block in `nginx/conf.d/apollo-sfs.conf` (streamed uploads, long timeouts) |
| Frontend | Profile page card (`FileServerLinksCard.tsx`, shows a Fast/Standard tier badge per link) + `frontend/src/components/FileServerLinkModal.tsx` (server + tier picker, per-device mount guide accordion, enhanced-security toggle), `frontend/src/routes/verify-location.$token.tsx` |

The creation modal shows a personalized mount guide (accordion, auto-expanded
on first link) based on the detected device OS — Windows, macOS, iOS, Android
or Linux (Ubuntu instructions), with Linux as the fallback when the device
cannot be discerned.
