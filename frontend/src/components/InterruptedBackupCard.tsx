import type { ReactNode } from 'react'
import { formatBackupBytes } from './BackupProgress'

// Shown in place of the running toolbar card when a background Google/email
// backup was still going when the page last unloaded — see api/backupSnapshot.ts.
// The provider token dies with the page, so this can't silently continue on
// its own; it just keeps the run from looking like it vanished, and offers a
// one-click way to sign back in and pick up with whatever's left.
export function InterruptedBackupCard({
  icon, title, doneCount, total, storedBytes, totalBytes, busy, error, onResume, onDiscard,
}: {
  icon: ReactNode
  title: string
  doneCount: number
  total: number
  storedBytes: number
  totalBytes: number
  busy: boolean
  error: string | null
  onResume: () => void
  onDiscard: () => void
}) {
  return (
    <div className="mb-3 px-3 py-2.5 bg-white border border-amber-200 rounded-lg shadow-sm flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 min-w-0">
        {icon}
        <span className="text-xs font-semibold text-amber-700 truncate">{title}</span>
      </div>
      <p className="text-[11px] text-gray-400 m-0">
        {doneCount} of {total} {total === 1 ? 'item' : 'items'} backed up
        {totalBytes > 0 && <> ({formatBackupBytes(storedBytes)} of {formatBackupBytes(totalBytes)})</>} before the page refreshed.
      </p>
      {error && <p className="text-[11px] text-red-500 m-0">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onResume}
          disabled={busy}
          className="flex-1 px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-default bg-blue-500 hover:bg-blue-600 text-white border-0"
        >
          {busy ? 'Signing in…' : 'Resume'}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={busy}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-default border border-gray-200 text-gray-600 hover:bg-gray-50"
        >
          Discard
        </button>
      </div>
    </div>
  )
}
