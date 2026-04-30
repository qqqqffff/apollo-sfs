import { useState, useCallback, useRef } from 'react'
import { uploadFile, initChunkedUpload, uploadChunk, completeChunkedUpload, CHUNK_SIZE } from '../api/files'

export type UploadStatus = 'idle' | 'uploading' | 'complete' | 'partial' | 'allFailed'
export type FileItemStatus = 'queued' | 'uploading' | 'done' | 'failed'

export interface FileUploadItem {
  name: string
  size: number    // file.size in bytes
  loaded: number  // bytes transferred so far
  status: FileItemStatus
}

export interface UploadProgress {
  status: UploadStatus
  items: FileUploadItem[]
  totalBytes: number
  loadedBytes: number
  speedBps: number   // bytes per second, computed from a sliding window
  succeeded: number
  failed: number
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

export function useFileUpload() {
  const [progress, setProgress] = useState<UploadProgress>(IDLE)

  // Mutable refs so XHR callbacks can update without triggering renders on every byte
  const liveRef   = useRef<UploadProgress>(IDLE)
  const samples   = useRef<{ t: number; loaded: number }[]>([])
  const flushTimer = useRef<ReturnType<typeof setInterval> | null>(null)

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

  // Upload a single file using the appropriate path (chunked vs single).
  // bytesOffset is the number of already-loaded bytes for this file item
  // before this call (used to compute absolute loaded position).
  async function uploadSingleFile(
    file: globalThis.File,
    folderId: string | null,
    itemIndex: number,
  ): Promise<void> {
    if (file.size <= CHUNK_SIZE) {
      // ── Single-request upload ──────────────────────────────────────────────
      await uploadFile(folderId, file, (xhrLoaded, xhrTotal) => {
        const scaled = xhrTotal > 0
          ? Math.min(Math.round((xhrLoaded / xhrTotal) * file.size), file.size)
          : xhrLoaded
        patchItem(itemIndex, { loaded: scaled })
      })
      return
    }

    // ── Chunked upload ─────────────────────────────────────────────────────
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
    const { upload_id } = await initChunkedUpload(file.name, totalChunks, file.size, folderId)

    for (let ci = 0; ci < totalChunks; ci++) {
      const start = ci * CHUNK_SIZE
      const chunk = file.slice(start, start + CHUNK_SIZE)
      const chunkSize = chunk.size
      // Bytes from completed chunks so far
      const completedBytes = ci * CHUNK_SIZE

      await uploadChunk(upload_id, ci, chunk, (xhrLoaded, xhrTotal) => {
        const chunkLoaded = xhrTotal > 0
          ? Math.min(Math.round((xhrLoaded / xhrTotal) * chunkSize), chunkSize)
          : xhrLoaded
        patchItem(itemIndex, { loaded: completedBytes + chunkLoaded })
      })
    }

    await completeChunkedUpload(upload_id)
  }

  const startUpload = useCallback(async (
    files: globalThis.File[],
    folderId: string | null,
    onAnySuccess: () => void,
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

    let succeededCount = 0
    let failedCount = 0

    await Promise.all(files.map(async (file, i) => {
      patchItem(i, { status: 'uploading' })

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          patchItem(i, { loaded: 0 })
          await sleep(RETRY_DELAYS_MS[attempt - 1])
        }
        try {
          await uploadSingleFile(file, folderId, i)
          patchItem(i, { loaded: file.size, status: 'done' })
          succeededCount++
          liveRef.current = { ...liveRef.current, succeeded: succeededCount }
          break
        } catch {
          if (attempt === MAX_RETRIES) {
            patchItem(i, { status: 'failed' })
            failedCount++
            liveRef.current = { ...liveRef.current, failed: failedCount }
          }
        }
      }
    }))

    const finalStatus: UploadStatus =
      failedCount === 0 ? 'complete' : succeededCount === 0 ? 'allFailed' : 'partial'

    liveRef.current = { ...liveRef.current, status: finalStatus }
    stopFlush()
    setProgress({ ...liveRef.current, speedBps: 0 })

    if (succeededCount > 0) onAnySuccess()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const dismiss = useCallback(() => {
    stopFlush()
    liveRef.current = IDLE
    samples.current = []
    setProgress(IDLE)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { progress, startUpload, dismiss }
}
