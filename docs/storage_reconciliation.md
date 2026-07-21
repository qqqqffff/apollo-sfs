# MinIO <-> Postgres Reconciliation

Apollo SFS stores encrypted blobs in MinIO and their metadata (filename,
folder, size, encryption nonce, and the MinIO object key) in Postgres. Every
upload and delete touches both systems as two separate steps, not one atomic
transaction, so a process crash or a partial failure between those steps can
leave them out of sync — the two drift scenarios users see as "ghost files":

- **Orphan object**: the blob exists in MinIO but no `files` (or
  `video_variants` / `recognition_detections`) row references it — invisible
  storage silently consuming capacity.
- **Ghost row**: a DB row references a MinIO object that no longer
  exists — the file shows up in the browser/API but downloading it 404s.

This document describes the drift sources, the reconciliation job that
detects and repairs them, and the daily heartbeat that runs it automatically.

## Where drift comes from

| Path | Order of operations | Drift window |
|------|---------------------|--------------|
| `FileService.Upload` (`routes/services/file.go`) | MinIO `PutObject` → DB `INSERT` → commit | Crash after the MinIO write, before the DB commit → orphan object |
| Chunked upload (`BeginChunkedUpload` → `FinalizeChunkedUpload`) | MinIO `CompleteMultipartUpload` → DB `INSERT` → commit | Same as above |
| Abandoned chunked upload | Client opens a multipart upload, then walks away | The 24h session-GC loop now aborts the multipart upload on expiry (`upload_session.go`) — previously it only zeroed key material, leaving the upload (and any parts already pushed) in the bucket forever |
| `FileService.Delete` | MinIO `RemoveObject` → DB `DELETE` → commit | Crash after the MinIO delete, before the DB commit → ghost row |
| Folder drive-tier migration (`folder_drive_migration.go`) | Copy to new drive's bucket → update `drive_id` → delete from old bucket | A failed old-bucket delete leaves a stale orphan under the *old* drive — this now also logs an inline reconciliation finding (`run_id` NULL) so it stays visible until the next scan cleans it up |

None of these are bugs in the everyday sense — they're inherent to "two
systems, two separate writes." The reconciliation job is the safety net,
following the same pattern already used elsewhere in this codebase for
missed-webhook drift (`payments.StartSubscriptionReconcileLoop`,
`orders.StartAllocationRevertLoop`).

## What the scanner does

`services.ReconciliationService` (`routes/services/reconciliation.go`), once
per active drive:

1. Lists every object in the drive's MinIO bucket (`MinIOService.ListObjects`).
2. Lists every DB row that should reference an object in that bucket:
   `files`, `video_variants`, and `recognition_detections` (all filtered by
   `drive_id`, joined through `files` for the latter two, since only `files`
   carries `drive_id` directly).
3. Diffs both directions:
   - **Orphan objects** — present in the bucket, referenced by none of the
     three tables — are **deleted**.
   - **Ghost rows** — a DB row whose object is missing — are **deleted**:
     - a ghost `files` row goes through `FileService.Delete`'s existing path
       (idempotent MinIO removal, row delete, quota refund) so the repair is
       indistinguishable from a normal user-initiated delete;
     - a ghost `video_variants` row is deleted outright (transcoded variants
       aren't counted against quota, so no refund is needed);
     - a ghost `recognition_detections` crop has its `thumb_*` fields cleared
       and the crop's bytes refunded from quota — the detection/embedding row
       itself is kept, since only the thumbnail image is gone.
   - **Abandoned multipart uploads** — incomplete, never completed or
     aborted, with no DB row (the upload path only inserts one after
     completing the multipart upload) — are **aborted**.
4. Every action (and any action that itself failed) is written to
   `reconciliation_findings`, linked to a `reconciliation_runs` row.

### Grace period

Nothing younger than **2 hours** is treated as drift — this is comfortably
longer than any real upload or delete can take, so an in-flight request never
gets mistaken for actual corruption while its MinIO write is done but its DB
commit hasn't landed yet (or vice versa for deletes).

### Per-drive for files, fleet-wide for variants and crops

A MinIO object key alone (`{userID}/{fileID}`) is only unique within one
drive's bucket — the same key string can legitimately exist under two
different buckets after a drive-tier migration. The scanner resolves each
active drive's MinIO client + bucket independently (`MinIORegistry.ClientForDrive`).

Primary `files` objects are diffed **per drive**, scoped to each row's
*current* `drive_id`: `Upload`/`Delete`/migration all guarantee a file's blob
lives only in its current drive's bucket, so a leftover object under an *old*
drive after a migration is correctly caught as an orphan (see the migration
row in the table above).

Video-variant and recognition-crop blobs are diffed **fleet-wide** instead:
folder drive-tier migration does not move them (see "Known limitation"
below), so a variant/crop can legitimately live in a bucket other than its
parent file's current `drive_id`. Scoping their presence check to one drive
would misclassify a variant that simply lives elsewhere as a ghost row (and
the still-live object in its actual bucket as an orphan). The scanner instead
lists every active drive's objects first, then checks each variant/crop key
against the *union* of all of them — only flagging a ghost when the key is
missing from every bucket, and never treating a variant/crop key as an
orphan-object candidate in any bucket it happens to be found in.

## The daily heartbeat

`ReconciliationService.DailyLoop`, started from `cmd/main.go`, runs one scan
every day at **4:00am in the server's local time zone** (`time.Local` — set
the `TZ` env var on the `api` container; `docker-stack.yml` defaults it to
`${TZ:-UTC}`, and `tzdata` is already installed in the image).

## Admin visibility

- `GET /api/v1/admin/system/reconciliation` — the most recent run (scheduled
  or manual) plus its findings, or `204` if none has ever run.
- `POST /api/v1/admin/system/reconciliation` — trigger a scan synchronously
  (`routes/admin/reconciliation.go`). Returns `503` if a scan is already in
  progress (the daily heartbeat and a manual trigger share one guard via
  `ReconciliationService.RunOnce`'s `CompareAndSwap`), or if the service
  wasn't wired up.

Both endpoints read/write `reconciliation_runs` / `reconciliation_findings`
(`db/38_reconciliation.sql`, `db/migrations/055_reconciliation.sql`) — there
is no in-memory cache to lose on a restart, unlike the speed-test endpoints.

## Known limitation

Video variants are **not** moved by the folder drive-migration flow (a
pre-existing V1 limitation noted in `folder_drive_migration.go`) — only the
primary file object. This means a variant (or a recognition crop, which is
never moved either) can end up living in a different bucket than its parent
file after a migration. The reconciliation scanner accounts for this by
diffing variant/crop keys fleet-wide rather than per-drive (see above), so
this limitation does not cause a live variant/crop to be misclassified as
drift — it just means the blob physically stays on whichever drive originally
created it, independent of where its parent file moves.
