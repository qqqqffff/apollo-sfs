import { useCallback, useRef, useState } from 'react'
import {
  createBackupControl,
  readCancelAction,
  type BackupControl,
  type BackupProgressEvent,
  type BackupRunResult,
  type CancelAction,
} from '../api/backupControl'
import { useBackupLiveSync } from './useBackupLiveSync'
import { useTransferRate } from './useTransferRate'

// Drives a backup that keeps running after its picker window closes (the
// "back up in the background" setting): progress for the toolbar card, the
// pause/resume/cancel controls, and the cancel dialog's keep-or-remove
// outcome. The Google and email flows differ only in what they call to move
// the data and to undo it, which they pass to start().

export interface BackgroundBackupState {
  running: boolean
  paused: boolean
  done: number
  total: number
  uploaded: number
  duplicates: number
  errors: number
  // Items actually written by this run, and their stored size.
  storedCount: number
  storedBytes: number
  // Size of the whole run, as estimated when it started.
  totalBytes: number
  // Destination of the item in flight, as a full path.
  currentPath: string | null
  // Bytes/sec estimate for the run so far — 0 until enough samples exist.
  speedBps: number
  // The item currently in flight's transfer stage, when the run reports one
  // (only the Google backup flow does, for a large file's download/upload).
  itemStage?: 'downloading' | 'uploading'
  itemLoadedBytes?: number
  itemTotalBytes?: number
  // Set once the run ends early (cancelled) — what happened to the partial data.
  note: string | null
  unit: 'file' | 'email'
}

export interface StartBackgroundBackup<R extends BackupRunResult> {
  total: number
  totalBytes: number
  unit: 'file' | 'email'
  // Drive the items land on, when known up front (email backups pin a folder
  // to one drive); Google uploads report it per file instead.
  driveId?: string | null
  run: (opts: {
    control: BackupControl
    onProgress: (e: BackupProgressEvent<unknown>) => void
  }) => Promise<R>
  // Deletes what the run stored — used when the user cancels and asks for the
  // partial backup to be removed.
  rollback?: (res: R) => Promise<{ removed: number; failed: number }>
  // Runs after the result (and any rollback) is in: run bookkeeping,
  // provider-side cleanup, notifications.
  onSettled?: (res: R, removed: number) => void | Promise<void>
}

export function useBackgroundBackup(extraInvalidateKeys: readonly (readonly unknown[])[] = []) {
  const [state, setState] = useState<BackgroundBackupState | null>(null)
  const [cancelPrompt, setCancelPrompt] = useState(false)
  const [rollbackBusy, setRollbackBusy] = useState(false)
  const controlRef = useRef<BackupControl | null>(null)
  const cancelActionRef = useRef<CancelAction>('keep')
  const liveSync = useBackupLiveSync(extraInvalidateKeys)
  // Mirrors state.storedBytes synchronously so the rate estimator always
  // records off a fresh value, not one captured by this closure at start().
  const storedBytesRef = useRef(0)
  const transferRate = useTransferRate()

  const start = useCallback(async <R extends BackupRunResult>(params: StartBackgroundBackup<R>) => {
    const control = createBackupControl()
    controlRef.current = control
    cancelActionRef.current = 'keep'
    storedBytesRef.current = 0
    transferRate.reset()
    setCancelPrompt(false)
    setState({
      running: true, paused: false, done: 0, total: params.total,
      uploaded: 0, duplicates: 0, errors: 0,
      storedCount: 0, storedBytes: 0, totalBytes: params.totalBytes,
      currentPath: null, speedBps: 0, note: null, unit: params.unit,
    })

    const res = await params.run({
      control,
      onProgress: (e) => {
        const stored = e.phase === 'settled' && e.status === 'done'
        if (stored) storedBytesRef.current += e.sizeBytes ?? 0
        const inFlightBytes = e.phase === 'progress' ? (e.loadedBytes ?? 0) : 0
        transferRate.record(storedBytesRef.current + inFlightBytes)
        const speedBps = transferRate.rate()

        setState((s) => {
          if (!s) return s
          return {
            ...s,
            done: e.done,
            total: e.total,
            currentPath: e.path,
            storedCount: s.storedCount + (stored ? 1 : 0),
            storedBytes: storedBytesRef.current,
            speedBps,
            itemStage: e.phase === 'progress' ? e.stage : undefined,
            itemLoadedBytes: e.phase === 'progress' ? e.loadedBytes : undefined,
            itemTotalBytes: e.phase === 'progress' ? e.itemTotalBytes : undefined,
          }
        })
        if (stored) {
          // Show it in the file browser and on the quota bar right away.
          liveSync.itemStored({ sizeBytes: e.sizeBytes ?? 0, driveId: e.driveId ?? params.driveId })
        }
      },
    })

    let removed = 0
    let note: string | null = null
    const action = readCancelAction(cancelActionRef)
    if (res.cancelled && action === 'remove' && params.rollback) {
      setRollbackBusy(true)
      const rollback = await params.rollback(res)
      removed = rollback.removed
      setRollbackBusy(false)
      note = rollback.failed === 0
        ? `Cancelled — ${removed} ${params.unit}${removed !== 1 ? 's' : ''} removed again.`
        : `Cancelled — ${removed} removed; ${rollback.failed} could not be deleted.`
    } else if (res.cancelled) {
      note = `Cancelled — ${res.uploaded} ${params.unit}${res.uploaded !== 1 ? 's' : ''} kept.`
    }

    controlRef.current = null
    setCancelPrompt(false)
    setState((s) => (s ? {
      ...s,
      running: false,
      paused: false,
      currentPath: null,
      uploaded: Math.max(0, res.uploaded - removed),
      duplicates: res.duplicates,
      errors: res.errors,
      note,
    } : s))
    liveSync.finish()

    await params.onSettled?.(res, removed)
  }, [liveSync, transferRate])

  const togglePause = useCallback(() => {
    const control = controlRef.current
    if (!control) return
    const nowPaused = !control.isPaused()
    if (nowPaused) control.pause(); else control.resume()
    setState((s) => (s ? { ...s, paused: nowPaused } : s))
  }, [])

  // Cancel pauses first, then asks what should happen to the part that landed.
  const requestCancel = useCallback(() => {
    controlRef.current?.pause()
    setState((s) => (s ? { ...s, paused: true } : s))
    setCancelPrompt(true)
  }, [])

  const resolveCancel = useCallback((action: CancelAction) => {
    cancelActionRef.current = action
    setCancelPrompt(false)
    // Releases the loop, which stops and returns a partial result; start()'s
    // continuation handles the rollback and the summary.
    controlRef.current?.cancel()
  }, [])

  const resumeFromPrompt = useCallback(() => {
    setCancelPrompt(false)
    controlRef.current?.resume()
    setState((s) => (s ? { ...s, paused: false } : s))
  }, [])

  const dismiss = useCallback(() => setState(null), [])

  return { state, cancelPrompt, rollbackBusy, start, togglePause, requestCancel, resolveCancel, resumeFromPrompt, dismiss }
}
