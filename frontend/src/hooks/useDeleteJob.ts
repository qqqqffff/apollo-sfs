import { useCallback, useRef, useState } from 'react'
import { deleteFile } from '../api/files'
import { deleteFolder, getFolder } from '../api/folders'
import type { File as ApiFile, Folder } from '../types/api'
import type { FileUploadItem, UploadProgress, UploadStatus } from './useFileUpload'

const IDLE: UploadProgress = {
  status: 'idle',
  items: [],
  totalBytes: 0,
  loadedBytes: 0,
  speedBps: 0,
  succeeded: 0,
  failed: 0,
  totalObjects: 0,
  doneObjects: 0,
  objectsPerSec: 0,
}

// How many file-deletes run at once while emptying a folder's subtree.
const DELETE_CONCURRENCY = 6
const PAGE_SIZE = 200
const FLUSH_MS = 150          // React state update frequency, matches useFileUpload
const RATE_WINDOW_MS = 3000   // sliding window for the objects/sec estimate

// A stuck request (dropped connection, a MinIO/Postgres hang) would otherwise
// stall the whole job — every network call the job makes is raced against
// this and fails fast instead, so one bad request costs 20s, not forever.
const DELETE_TIMEOUT_MS = 20_000

export interface DeleteTarget {
  type: 'file' | 'folder'
  id: string
  name: string
  sizeBytes: number
}

function withTimeout<T>(promise: Promise<T>, ms: number = DELETE_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 1000)}s`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

// Pages through one folder's direct contents (both cursors independently,
// like useInfiniteFolderContents) until both are exhausted. onFiles fires
// once per page of files discovered, so a caller can grow a running total
// live instead of waiting for the whole subtree to be walked.
async function listAllContents(
  folderId: string,
  onFiles?: (files: ApiFile[]) => void,
): Promise<{ files: ApiFile[]; folders: Folder[] }> {
  const files: ApiFile[] = []
  const folders: Folder[] = []
  let folderCursor: string | undefined
  let fileCursor: string | undefined
  let folderDone = false
  let fileDone = false

  for (;;) {
    const page = await withTimeout(getFolder(folderId, {
      folderCursor,
      fileCursor,
      folderLimit: folderDone ? 0 : PAGE_SIZE,
      fileLimit: fileDone ? 0 : PAGE_SIZE,
    }))
    if (!folderDone) {
      folders.push(...page.subfolders.items)
      folderCursor = page.subfolders.next_token || undefined
      if (!folderCursor) folderDone = true
    }
    if (!fileDone) {
      files.push(...page.files.items)
      if (page.files.items.length > 0) onFiles?.(page.files.items)
      fileCursor = page.files.next_token || undefined
      if (!fileCursor) fileDone = true
    }
    if (folderDone && fileDone) break
  }
  return { files, folders }
}

// Recursively walks a folder's subtree, returning every file under it plus
// every subfolder id in post-order (children before their parent) so each
// folder is only deleted once it's already empty. Exported so the delete
// confirmation modal can build the same "what's about to be deleted" preview
// (file list + quota impact) the job itself will act on. onFiles, when
// given, fires as each page of files is discovered (depth-first) — the job
// uses it to grow the toast's object total live during the enumeration.
export async function enumerateFolderContents(
  folderId: string,
  onFiles?: (files: ApiFile[]) => void,
): Promise<{ files: ApiFile[]; folderIdsPostOrder: string[] }> {
  const { files, folders } = await listAllContents(folderId, onFiles)
  const allFiles = [...files]
  const folderIdsPostOrder: string[] = []
  for (const sub of folders) {
    const nested = await enumerateFolderContents(sub.id, onFiles)
    allFiles.push(...nested.files)
    folderIdsPostOrder.push(...nested.folderIdsPostOrder)
  }
  folderIdsPostOrder.push(folderId)
  return { files: allFiles, folderIdsPostOrder }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Delete failed'
}

// useDeleteJob drives a delete (single file, single email message, or a
// folder-with-contents that needs its whole subtree emptied first) and
// reports progress in the same shape useFileUpload does, so it renders with
// the existing <UploadToast/> (mirrors useDriveMigrationProgress, which maps
// a different kind of job onto the same UploadProgress shape).
//
// A folder target is enumerated before anything is deleted: totalObjects
// grows live as pages of its subtree are discovered (so a 10,000-message
// email backup folder shows "0 / 10,000", not "0 / 1"), then doneObjects and
// loadedBytes climb per file as the deletes actually happen — not just once
// at the very end.
export function useDeleteJob() {
  const [progress, setProgress] = useState<UploadProgress>(IDLE)
  const liveRef = useRef<UploadProgress>(IDLE)
  const samples = useRef<{ t: number; count: number }[]>([])
  const flushTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  function recordSample(doneObjects: number) {
    const now = Date.now()
    samples.current.push({ t: now, count: doneObjects })
    const cutoff = now - RATE_WINDOW_MS
    while (samples.current.length > 2 && samples.current[0].t < cutoff) {
      samples.current.shift()
    }
  }

  function computeRate(): number {
    const s = samples.current
    if (s.length < 2) return 0
    const dt = (s[s.length - 1].t - s[0].t) / 1000
    if (dt < 0.05) return 0
    return Math.max(0, (s[s.length - 1].count - s[0].count) / dt)
  }

  function startFlush() {
    if (flushTimer.current) return
    flushTimer.current = setInterval(() => {
      const live = liveRef.current
      recordSample(live.doneObjects ?? 0)
      setProgress({ ...live, objectsPerSec: computeRate() })
    }, FLUSH_MS)
  }

  function stopFlush() {
    if (flushTimer.current) { clearInterval(flushTimer.current); flushTimer.current = null }
  }

  // Mutates liveRef only — picked up by the flush timer, same as
  // useFileUpload's patchItem, so bursts of small updates (a batch of file
  // deletes, pages of subtree discovery) don't each force a render.
  function patchItem(index: number, patch: Partial<FileUploadItem>) {
    const items = liveRef.current.items.slice()
    items[index] = { ...items[index], ...patch }
    const loadedBytes = items.reduce((s, it) => s + it.loaded, 0)
    liveRef.current = { ...liveRef.current, items, loadedBytes }
  }

  const startDelete = useCallback(async (targets: DeleteTarget[]) => {
    const items: FileUploadItem[] = targets.map((t) => ({
      name: t.name,
      size: t.sizeBytes,
      loaded: 0,
      status: 'queued',
    }))
    const totalBytes = targets.reduce((s, t) => s + t.sizeBytes, 0)
    // Folder targets' real object counts aren't known yet — enumeration
    // grows this live as each one is walked, further down.
    const initialObjects = targets.filter((t) => t.type === 'file').length

    liveRef.current = {
      status: 'uploading', items, totalBytes, loadedBytes: 0, speedBps: 0,
      succeeded: 0, failed: 0, totalObjects: initialObjects, doneObjects: 0, objectsPerSec: 0,
    }
    samples.current = []
    setProgress(liveRef.current)
    startFlush()

    let succeeded = 0
    let failed = 0
    let doneObjects = 0

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]
      patchItem(i, { status: 'uploading' })
      try {
        if (target.type === 'file') {
          await withTimeout(deleteFile(target.id))
          doneObjects++
          patchItem(i, { status: 'done', loaded: target.sizeBytes })
        } else {
          const { files, folderIdsPostOrder } = await enumerateFolderContents(target.id, (batch) => {
            liveRef.current = { ...liveRef.current, totalObjects: (liveRef.current.totalObjects ?? 0) + batch.length }
          })

          let anyFileFailed = false
          let targetLoaded = 0
          for (let b = 0; b < files.length; b += DELETE_CONCURRENCY) {
            const batch = files.slice(b, b + DELETE_CONCURRENCY)
            const results = await Promise.allSettled(batch.map((f) => withTimeout(deleteFile(f.id))))
            results.forEach((r, idx) => {
              if (r.status === 'fulfilled') {
                doneObjects++
                targetLoaded += batch[idx].size_bytes
              } else {
                anyFileFailed = true
              }
            })
            patchItem(i, { loaded: targetLoaded })
          }
          if (anyFileFailed) throw new Error('some contents failed to delete')
          for (const folderId of folderIdsPostOrder) {
            await withTimeout(deleteFolder(folderId))
          }
          patchItem(i, { status: 'done', loaded: target.sizeBytes })
        }
        succeeded++
      } catch (err) {
        patchItem(i, { status: 'failed', error: errorMessage(err) })
        failed++
      }
      liveRef.current = { ...liveRef.current, succeeded, failed, doneObjects }
    }

    stopFlush()
    const finalStatus: UploadStatus = failed === 0 ? 'complete' : succeeded === 0 ? 'allFailed' : 'partial'
    liveRef.current = { ...liveRef.current, status: finalStatus, speedBps: 0, objectsPerSec: 0 }
    setProgress(liveRef.current)

    return { succeeded, failed }
  }, [])

  const dismiss = useCallback(() => {
    stopFlush()
    liveRef.current = IDLE
    samples.current = []
    setProgress(IDLE)
  }, [])

  return { progress, startDelete, dismiss }
}
