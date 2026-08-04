// Pause / resume / cancel plumbing shared by the Google and email backup
// flows. Both upload loops are plain sequential `for` loops in the browser, so
// control is exercised between items: the loop awaits `gate()` before starting
// each one, which resolves immediately while running, blocks while paused, and
// reports `false` once cancelled so the loop can stop and hand back a partial
// result (see BackupRunResult.cancelled).
//
// An item already in flight always finishes — pausing mid-transfer would leave
// a half-written object server-side, and every item is small enough that the
// wait is imperceptible.

export type BackupControlState = 'running' | 'paused' | 'cancelled'

export interface BackupControl {
  state(): BackupControlState
  isPaused(): boolean
  isCancelled(): boolean
  pause(): void
  resume(): void
  cancel(): void
  // Resolves true when the next item may start, false when the run was
  // cancelled. Blocks for as long as the run is paused.
  gate(): Promise<boolean>
  // Notified on every state change; returns an unsubscribe function.
  subscribe(listener: (state: BackupControlState) => void): () => void
}

export function createBackupControl(): BackupControl {
  let state: BackupControlState = 'running'
  const listeners = new Set<(s: BackupControlState) => void>()
  // Resolvers of gate() calls parked while paused.
  let waiters: (() => void)[] = []

  function set(next: BackupControlState) {
    if (state === next || state === 'cancelled') return
    state = next
    if (next !== 'paused') {
      const parked = waiters
      waiters = []
      parked.forEach((resolve) => resolve())
    }
    listeners.forEach((l) => l(state))
  }

  return {
    state: () => state,
    isPaused: () => state === 'paused',
    isCancelled: () => state === 'cancelled',
    pause: () => set('paused'),
    resume: () => set('running'),
    cancel: () => set('cancelled'),
    async gate() {
      while (state === 'paused') {
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
      return state !== 'cancelled'
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

// ── Cancelling ────────────────────────────────────────────────────────────────

// What a cancelled run does with the part that already landed.
export type CancelAction = 'keep' | 'remove'

// readCancelAction exists so the choice can be read back after the run stops.
// Reading through a function keeps TypeScript from narrowing the ref to the
// value it was initialised with: the cancel dialog assigns it from its own
// callback, which control-flow analysis can't see.
export function readCancelAction(ref: { current: CancelAction }): CancelAction {
  return ref.current
}

// ── Shared progress/result shapes ─────────────────────────────────────────────

export type BackupItemStatus = 'done' | 'duplicate' | 'error'

// One event per item, at least twice: 'start' just before it is
// fetched/uploaded (drives the "currently backing up …" line) and 'settled'
// once it landed or failed (drives the counters, the quota bar, and the file
// listing refresh). Large items additionally fire 'progress' any number of
// times in between — the Google backup flow uses this for a big Drive/Photos
// file's download and upload, each of which can otherwise run for minutes
// with nothing to show for it.
export interface BackupProgressEvent<E> {
  phase: 'start' | 'progress' | 'settled'
  entry: E
  index: number
  done: number
  total: number
  // Destination of this item as a full path, e.g. "Photos/IMG_0042.jpg".
  path: string
  // Settled only:
  status?: BackupItemStatus
  // Bytes actually stored server-side (0 for duplicates/errors).
  sizeBytes?: number
  // Ids needed to undo this item if the run is cancelled and the user asks
  // for the partial backup to be removed.
  fileId?: string
  messageId?: string
  // Drive the file landed on, when the server reports it.
  driveId?: string | null
  // Reason the item failed, when status is 'error' — surfaced in the UI and
  // used to scope a retry to just the items that need it.
  error?: string
  // Progress only — which half of the transfer this item is in and how far
  // it has gotten. itemTotalBytes can be unknown even mid-transfer (Google
  // Photos items don't report a size up front).
  stage?: 'downloading' | 'uploading'
  loadedBytes?: number
  itemTotalBytes?: number
}

export interface BackupRunResult {
  uploaded: number
  duplicates: number
  errors: number
  // True when the run stopped early because the user cancelled it.
  cancelled: boolean
  // Files written by this run, in order — the rollback list for a cancel.
  uploadedFileIds: string[]
}
