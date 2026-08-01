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

export type UploadStatus = 'idle' | 'uploading' | 'complete' | 'partial' | 'allFailed'
export type FileItemStatus = 'queued' | 'uploading' | 'done' | 'failed'

export interface FileUploadItem {
  name: string
  size: number    // file.size in bytes
  loaded: number  // bytes transferred so far
  status: FileItemStatus
  error?: string  // reason the upload failed, set once all retries are exhausted
}

export interface UploadProgress {
  status: UploadStatus
  items: FileUploadItem[]
  totalBytes: number
  loadedBytes: number
  speedBps: number   // bytes per second, computed from a sliding window
  succeeded: number
  failed: number
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

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Upload failed'
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
  // upload (folderId null) to the drive whose view the user is in.
  async function uploadSingleFile(
    file: globalThis.File,
    folderId: string | null,
    itemIndex: number,
    ignoreRedirect: boolean,
    driveId: string | null,
  ): Promise<void> {
    if (file.size <= CHUNK_SIZE) {
      // ── Presigned single-file upload ───────────────────────────────────────
      const { url } = await presignUpload(file.name, file.size, folderId, ignoreRedirect, driveId)
      await uploadFilePresigned(url, file, (xhrLoaded, xhrTotal) => {
        const scaled = xhrTotal > 0
          ? Math.min(Math.round((xhrLoaded / xhrTotal) * file.size), file.size)
          : xhrLoaded
        patchItem(itemIndex, { loaded: scaled })
      })
      return
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
    let firstError: unknown = null

    async function chunkWorker() {
      while (firstError === null) {
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
        } catch (err) {
          if (firstError === null) firstError = err
          return
        }
      }
    }

    const workerCount = Math.min(MAX_CONCURRENT_CHUNKS, totalChunks)
    await Promise.all(Array.from({ length: workerCount }, () => chunkWorker()))
    if (firstError !== null) throw firstError

    await completeChunkedUploadPresigned(upload_id, session_token)
  }

  // Runs the retry loop for a single file/index, patching its item state as it
  // goes. Shared by startUpload (fresh queue) and retryFailed (failed subset).
  async function attemptFile(
    file: globalThis.File,
    itemIndex: number,
    folderId: string | null,
    ignoreRedirect: boolean,
    driveId: string | null,
  ): Promise<boolean> {
    patchItem(itemIndex, { status: 'uploading', loaded: 0, error: undefined })

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        patchItem(itemIndex, { loaded: 0 })
        await sleep(RETRY_DELAYS_MS[attempt - 1])
      }
      try {
        await uploadSingleFile(file, folderId, itemIndex, ignoreRedirect, driveId)
        patchItem(itemIndex, { loaded: file.size, status: 'done', error: undefined })
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
  ) => {
    const items: FileUploadItem[] = files.map((f) => ({
      name: f.name,
      size: f.size,
      loaded: 0,
      status: 'queued',
    }))
    const totalBytes = files.reduce((s, f) => s + f.size, 0)

    liveRef.current = { status: 'uploading', items, totalBytes, loadedBytes: 0, speedBps: 0, succeeded: 0, failed: 0 }
    samples.current = []
    setProgress(liveRef.current)
    startFlush()
    lastArgsRef.current = { files, folderId, ignoreRedirectIndices, driveId: driveId ?? null }

    let succeededCount = 0
    let failedCount = 0

    await Promise.all(files.map(async (file, i) => {
      const ok = await attemptFile(file, i, folderId, ignoreRedirectIndices?.has(i) ?? false, driveId ?? null)
      if (ok) {
        succeededCount++
        liveRef.current = { ...liveRef.current, succeeded: succeededCount }
      } else {
        failedCount++
        liveRef.current = { ...liveRef.current, failed: failedCount }
      }
    }))

    const finalStatus: UploadStatus =
      failedCount === 0 ? 'complete' : succeededCount === 0 ? 'allFailed' : 'partial'

    liveRef.current = { ...liveRef.current, status: finalStatus }
    stopFlush()
    setProgress({ ...liveRef.current, speedBps: 0 })

    if (succeededCount > 0) onAnySuccess()
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

    liveRef.current = { ...liveRef.current, status: 'uploading' }
    setProgress(liveRef.current)
    startFlush()

    let newlySucceeded = 0

    await Promise.all(failedIndices.map(async (i) => {
      const ok = await attemptFile(
        args.files[i], i, args.folderId, args.ignoreRedirectIndices?.has(i) ?? false, args.driveId,
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

  const dismiss = useCallback(() => {
    stopFlush()
    liveRef.current = IDLE
    samples.current = []
    lastArgsRef.current = null
    setProgress(IDLE)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { progress, startUpload, retryFailed, dismiss }
}
