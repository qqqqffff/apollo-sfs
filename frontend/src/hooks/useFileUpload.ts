import { useState, useCallback, useRef } from 'react'
import {
  uploadFilePresigned,
  presignUpload,
  presignChunkedUpload,
  uploadChunkPresigned,
  completeChunkedUploadPresigned,
  CHUNK_SIZE,
  MAX_CONCURRENT_CHUNKS,
} from '../api/files'
import { createBackupControl, type BackupControl } from '../api/backupControl'

export type UploadStatus = 'idle' | 'uploading' | 'complete' | 'partial' | 'allFailed' | 'cancelled'
export type FileItemStatus = 'queued' | 'uploading' | 'done' | 'failed'

export interface FileUploadItem {
  name: string
  size: number    // file.size in bytes
  loaded: number  // bytes transferred so far
  status: FileItemStatus
  error?: string  // reason the upload failed, set once all retries are exhausted
  // Id of the file this item landed as once done — lets a cancelled run be
  // rolled back (delete whatever already made it in), same as a cancelled
  // backup's uploadedFileIds/uploadedMessageIds.
  fileId?: string
}

export interface UploadProgress {
  status: UploadStatus
  items: FileUploadItem[]
  totalBytes: number
  loadedBytes: number
  speedBps: number   // bytes per second, computed from a sliding window
  succeeded: number
  failed: number
  // True while the run is paused (same pause/resume/cancel control the
  // Google/email backup flows use — see api/backupControl.ts).
  paused?: boolean
  // Recursive object total/done count for jobs whose real unit of work is
  // finer-grained than `items` — e.g. deleting a folder recursively
  // enumerates its whole subtree, so `items` stays one row per top-level
  // target while these report the true file count. Unset for a plain
  // upload, where one item already is one object; UploadToast falls back to
  // items.length / (succeeded+failed) in that case.
  totalObjects?: number
  doneObjects?: number
  // Objects completed per second (sliding window), analogous to speedBps but
  // for jobs where object count is a more meaningful completion-time basis
  // than bytes/sec — a delete request costs roughly the same regardless of
  // the file's size, so bytes/sec would be a poor ETA estimate for one.
  objectsPerSec?: number
}

const IDLE: UploadProgress = {
  status: 'idle',
  items: [],
  totalBytes: 0,
  loadedBytes: 0,
  speedBps: 0,
  succeeded: 0,
  failed: 0,
}

const MAX_RETRIES = 5
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000]
const FLUSH_MS = 150      // React state update frequency
const SPEED_WINDOW_MS = 3000
// How many files may be uploading at once — the pause/cancel control (same
// one the Google/email backup flows use) only stops *new* work from
// starting, so a batch needs an actual queue for that to mean anything;
// without a cap every file would already be dispatched before a click could
// land. Matches MAX_CONCURRENT_CHUNKS's reasoning for a single large file.
const MAX_CONCURRENT_FILES = 4

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Upload failed'
}

export interface UploadResult {
  succeeded: number
  failed: number
  cancelled: boolean
  // Ids of files that landed this run, in completion order — the rollback
  // list if the user cancels and asks for the partial upload to be removed.
  uploadedFileIds: string[]
}

interface LastUploadArgs {
  files: globalThis.File[]
  folderId: string | null
  ignoreRedirectIndices?: Set<number>
  driveId: string | null
}

export function useFileUpload() {
  const [progress, setProgress] = useState<UploadProgress>(IDLE)

  // Mutable refs so XHR callbacks can update without triggering renders on every byte
  const liveRef   = useRef<UploadProgress>(IDLE)
  const samples   = useRef<{ t: number; loaded: number }[]>([])
  const flushTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastArgsRef = useRef<LastUploadArgs | null>(null)
  const controlRef = useRef<BackupControl | null>(null)

  function recordSample(loaded: number) {
    const now = Date.now()
    samples.current.push({ t: now, loaded })
    const cutoff = now - SPEED_WINDOW_MS
    while (samples.current.length > 2 && samples.current[0].t < cutoff) {
      samples.current.shift()
    }
  }

  function computeSpeed(): number {
    const s = samples.current
    if (s.length < 2) return 0
    const dt = (s[s.length - 1].t - s[0].t) / 1000
    if (dt < 0.05) return 0
    return Math.max(0, (s[s.length - 1].loaded - s[0].loaded) / dt)
  }

  function startFlush() {
    if (flushTimer.current) return
    flushTimer.current = setInterval(() => {
      const live = liveRef.current
      recordSample(live.loadedBytes)
      setProgress({ ...live, speedBps: computeSpeed() })
    }, FLUSH_MS)
  }

  function stopFlush() {
    if (flushTimer.current) { clearInterval(flushTimer.current); flushTimer.current = null }
  }

  // Mutate a single item in liveRef and recompute aggregate loadedBytes
  function patchItem(index: number, patch: Partial<FileUploadItem>) {
    const items = liveRef.current.items.slice()
    items[index] = { ...items[index], ...patch }
    const loadedBytes = items.reduce((s, it) => s + it.loaded, 0)
    liveRef.current = { ...liveRef.current, items, loadedBytes }
  }

  // Upload a single file using the presigned URL flow. driveId pins a root
  // upload (folderId null) to the drive whose view the user is in. Returns
  // the file id it landed as, for the cancel-rollback list. Chunk claims are
  // gated on `control` so pausing/cancelling a huge file stops queuing new
  // chunks (in-flight ones still finish) instead of only taking effect
  // between whole files.
  async function uploadSingleFile(
    file: globalThis.File,
    folderId: string | null,
    itemIndex: number,
    ignoreRedirect: boolean,
    driveId: string | null,
    control: BackupControl,
  ): Promise<string> {
    if (file.size <= CHUNK_SIZE) {
      // ── Presigned single-file upload ───────────────────────────────────────
      const { url } = await presignUpload(file.name, file.size, folderId, ignoreRedirect, driveId)
      const res = await uploadFilePresigned(url, file, (xhrLoaded, xhrTotal) => {
        const scaled = xhrTotal > 0
          ? Math.min(Math.round((xhrLoaded / xhrTotal) * file.size), file.size)
          : xhrLoaded
        patchItem(itemIndex, { loaded: scaled })
      })
      return res.id
    }

    // ── Presigned chunked upload ───────────────────────────────────────────
    // Chunks upload through a small worker pool rather than one at a time: the
    // backend accepts them out of order (each is dispatched to its own goroutine
    // and completed as an independently numbered MinIO multipart part), so
    // serializing them client-side only wastes round-trip latency — with one
    // chunk in flight, per-file throughput is capped at CHUNK_SIZE / RTT instead
    // of the user's actual link speed.
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
    const { upload_id, session_token } = await presignChunkedUpload(
      file.name,
      totalChunks,
      file.size,
      folderId,
      ignoreRedirect,
      driveId,
    )

    const chunkLoaded = new Array<number>(totalChunks).fill(0)
    function reportChunkProgress(ci: number, loaded: number) {
      chunkLoaded[ci] = loaded
      patchItem(itemIndex, { loaded: chunkLoaded.reduce((a, b) => a + b, 0) })
    }

    let nextChunk = 0
    let chunksDone = 0
    let firstError: unknown = null

    async function chunkWorker() {
      while (firstError === null) {
        if (!(await control.gate())) return // cancelled — stop claiming new chunks
        const ci = nextChunk++
        if (ci >= totalChunks) return
        const start = ci * CHUNK_SIZE
        const chunk = file.slice(start, start + CHUNK_SIZE)
        const chunkSize = chunk.size
        try {
          await uploadChunkPresigned(upload_id, session_token, ci, chunk, (xhrLoaded, xhrTotal) => {
            const loaded = xhrTotal > 0
              ? Math.min(Math.round((xhrLoaded / xhrTotal) * chunkSize), chunkSize)
              : xhrLoaded
            reportChunkProgress(ci, loaded)
          })
          reportChunkProgress(ci, chunkSize)
          chunksDone++
        } catch (err) {
          if (firstError === null) firstError = err
          return
        }
      }
    }

    const workerCount = Math.min(MAX_CONCURRENT_CHUNKS, totalChunks)
    await Promise.all(Array.from({ length: workerCount }, () => chunkWorker()))
    if (firstError !== null) throw firstError
    if (chunksDone < totalChunks) throw new Error('Cancelled')

    const res = await completeChunkedUploadPresigned(upload_id, session_token)
    return res.id
  }

  // Runs the retry loop for a single file/index, patching its item state as it
  // goes. Shared by startUpload (fresh queue) and retryFailed (failed subset).
  // Gated on `control` between retry attempts, mirroring backupControl's
  // "already in flight always finishes" — an attempt already running isn't
  // interrupted, but a paused/cancelled run won't start another one.
  async function attemptFile(
    file: globalThis.File,
    itemIndex: number,
    folderId: string | null,
    ignoreRedirect: boolean,
    driveId: string | null,
    control: BackupControl,
  ): Promise<boolean> {
    patchItem(itemIndex, { status: 'uploading', loaded: 0, error: undefined })

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        patchItem(itemIndex, { loaded: 0 })
        await sleep(RETRY_DELAYS_MS[attempt - 1])
        if (!(await control.gate())) {
          patchItem(itemIndex, { status: 'failed', error: 'Cancelled' })
          return false
        }
      }
      try {
        const fileId = await uploadSingleFile(file, folderId, itemIndex, ignoreRedirect, driveId, control)
        patchItem(itemIndex, { loaded: file.size, status: 'done', error: undefined, fileId })
        return true
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          patchItem(itemIndex, { status: 'failed', error: errorMessage(err) })
          return false
        }
      }
    }
    return false
  }

  const startUpload = useCallback(async (
    files: globalThis.File[],
    folderId: string | null,
    onAnySuccess: () => void,
    ignoreRedirectIndices?: Set<number>,
    driveId?: string | null,
  ): Promise<UploadResult> => {
    const items: FileUploadItem[] = files.map((f) => ({
      name: f.name,
      size: f.size,
      loaded: 0,
      status: 'queued',
    }))
    const totalBytes = files.reduce((s, f) => s + f.size, 0)
    const control = createBackupControl()
    controlRef.current = control

    liveRef.current = {
      status: 'uploading', items, totalBytes, loadedBytes: 0, speedBps: 0,
      succeeded: 0, failed: 0, paused: false,
    }
    samples.current = []
    setProgress(liveRef.current)
    startFlush()
    lastArgsRef.current = { files, folderId, ignoreRedirectIndices, driveId: driveId ?? null }

    let succeededCount = 0
    let failedCount = 0
    let nextFile = 0

    async function fileWorker() {
      for (;;) {
        if (!(await control.gate())) return // cancelled — stop claiming new files
        const i = nextFile++
        if (i >= files.length) return
        const ok = await attemptFile(
          files[i], i, folderId, ignoreRedirectIndices?.has(i) ?? false, driveId ?? null, control,
        )
        if (ok) {
          succeededCount++
          liveRef.current = { ...liveRef.current, succeeded: succeededCount }
        } else {
          failedCount++
          liveRef.current = { ...liveRef.current, failed: failedCount }
        }
      }
    }

    const workerCount = Math.min(MAX_CONCURRENT_FILES, files.length)
    await Promise.all(Array.from({ length: workerCount }, fileWorker))

    const cancelled = control.isCancelled()
    const finalStatus: UploadStatus = cancelled
      ? 'cancelled'
      : failedCount === 0 ? 'complete' : succeededCount === 0 ? 'allFailed' : 'partial'

    liveRef.current = { ...liveRef.current, status: finalStatus, paused: false }
    stopFlush()
    setProgress({ ...liveRef.current, speedBps: 0 })
    controlRef.current = null

    if (succeededCount > 0) onAnySuccess()

    const uploadedFileIds = liveRef.current.items
      .filter((it) => it.status === 'done' && it.fileId)
      .map((it) => it.fileId as string)
    return { succeeded: succeededCount, failed: failedCount, cancelled, uploadedFileIds }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // retryFailed re-attempts only the items still in 'failed' status, using the
  // same folder/redirect/drive routing as the run that produced them. The
  // original File objects are kept in lastArgsRef, so no re-picking is needed.
  const retryFailed = useCallback(async (onAnySuccess: () => void) => {
    const args = lastArgsRef.current
    if (!args) return
    const failedIndices = liveRef.current.items
      .map((it, i) => (it.status === 'failed' ? i : -1))
      .filter((i) => i >= 0)
    if (failedIndices.length === 0) return

    // A short, always-runs-to-completion re-attempt of a handful of items
    // doesn't need its own pause/cancel control — same as the backup flows'
    // own retry (EmailBackupModal/GoogleBackupModal's handleRetryFailed).
    const control = createBackupControl()

    liveRef.current = { ...liveRef.current, status: 'uploading' }
    setProgress(liveRef.current)
    startFlush()

    let newlySucceeded = 0

    await Promise.all(failedIndices.map(async (i) => {
      const ok = await attemptFile(
        args.files[i], i, args.folderId, args.ignoreRedirectIndices?.has(i) ?? false, args.driveId, control,
      )
      if (ok) {
        newlySucceeded++
        liveRef.current = {
          ...liveRef.current,
          succeeded: liveRef.current.succeeded + 1,
          failed: liveRef.current.failed - 1,
        }
      }
    }))

    const finalStatus: UploadStatus =
      liveRef.current.failed === 0 ? 'complete' : liveRef.current.succeeded === 0 ? 'allFailed' : 'partial'

    liveRef.current = { ...liveRef.current, status: finalStatus }
    stopFlush()
    setProgress({ ...liveRef.current, speedBps: 0 })

    if (newlySucceeded > 0) onAnySuccess()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Pause/resume/cancel mirror the Google/email backup flows exactly (same
  // BackupControl): pause blocks new files/chunks/retries from starting
  // while letting whatever's already in flight finish; cancel does the same
  // and additionally ends the run early, reporting `cancelled: true` in the
  // result returned by startUpload so the caller can offer to roll back
  // whatever already landed (see BackupCancelModal).
  const pause = useCallback(() => {
    controlRef.current?.pause()
    liveRef.current = { ...liveRef.current, paused: true }
    setProgress(liveRef.current)
  }, [])

  const resume = useCallback(() => {
    controlRef.current?.resume()
    liveRef.current = { ...liveRef.current, paused: false }
    setProgress(liveRef.current)
  }, [])

  const cancel = useCallback(() => {
    controlRef.current?.cancel()
  }, [])

  const dismiss = useCallback(() => {
    stopFlush()
    liveRef.current = IDLE
    samples.current = []
    lastArgsRef.current = null
    controlRef.current = null
    setProgress(IDLE)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { progress, startUpload, retryFailed, dismiss, pause, resume, cancel }
}
