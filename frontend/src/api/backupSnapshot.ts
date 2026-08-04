// Lets an in-progress Google/email background backup survive a page refresh
// without silently vanishing. The download/upload loop runs entirely in the
// browser (see api/googleBackup.ts, api/emailBackup.ts) — a refresh kills it
// mid-flight, and the provider OAuth token dies with it, so this can't
// auto-resume unattended. What it can do: remember how far the run got, so
// the toolbar card comes back as "interrupted" with the real tally instead
// of just disappearing, and offer a Resume button that re-authenticates and
// continues with only the entries that hadn't been attempted yet.
//
// Only plain, already-fetched item metadata is persisted (file/message ids,
// names, sizes, destinations) — never the access token itself.

// C is whatever small, per-flow context the run needs besides the entries
// themselves — e.g. the email flow's destination folder/drive and provider,
// which aren't per-item. Google has none of this (an entry already carries
// its own destination), so it uses C = null.
export interface BackupSnapshot<E, C> {
  // The full original list, in the order the run processes them.
  entries: E[]
  // How many of `entries` had already settled (done, duplicate, or error)
  // when the snapshot was last written — the run is strictly sequential, so
  // `entries.slice(doneCount)` is exactly what's left to attempt.
  doneCount: number
  totalBytes: number
  uploaded: number
  duplicates: number
  errors: number
  storedCount: number
  storedBytes: number
  savedAt: string
  context: C
}

const WRITE_THROTTLE_MS = 1000

export interface BackupSnapshotStore<E, C> {
  // Throttled — fine for the steady stream of per-item updates during a run.
  save(snapshot: BackupSnapshot<E, C>): void
  // Writes immediately, bypassing the throttle. Use for the first write of a
  // run and any write that must not be lost to a still-pending timer.
  saveNow(snapshot: BackupSnapshot<E, C>): void
  load(): BackupSnapshot<E, C> | null
  clear(): void
}

export function makeBackupSnapshotStore<E, C = null>(key: string): BackupSnapshotStore<E, C> {
  let lastWrite = 0
  let pending: BackupSnapshot<E, C> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function flush() {
    if (timer) { clearTimeout(timer); timer = null }
    if (!pending) return
    lastWrite = Date.now()
    const toWrite = pending
    pending = null
    try { localStorage.setItem(key, JSON.stringify(toWrite)) } catch { /* storage full/unavailable — best effort */ }
  }

  return {
    save(snapshot) {
      pending = snapshot
      const wait = Math.max(0, WRITE_THROTTLE_MS - (Date.now() - lastWrite))
      if (wait === 0) { flush(); return }
      if (timer) return
      timer = setTimeout(flush, wait)
    },
    saveNow(snapshot) {
      pending = snapshot
      flush()
    },
    load() {
      try {
        const raw = localStorage.getItem(key)
        return raw ? (JSON.parse(raw) as BackupSnapshot<E, C>) : null
      } catch {
        return null
      }
    },
    clear() {
      if (timer) { clearTimeout(timer); timer = null }
      pending = null
      try { localStorage.removeItem(key) } catch { /* ignore */ }
    },
  }
}
