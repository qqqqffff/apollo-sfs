import { useEffect } from 'react'
import { MdDeleteOutline, MdPlayArrow, MdSaveAlt, MdWarningAmber } from 'react-icons/md'
import { formatBackupBytes } from './BackupProgress'

interface Props {
  // What the partial run produced so far.
  storedCount: number
  storedBytes: number
  unit: 'file' | 'email'
  // True while the removal is running.
  busy?: boolean
  // Stop the run and delete everything it stored.
  onRemove: () => void
  // Stop the run and keep what it stored.
  onKeep: () => void
  // Never mind — carry on where it left off.
  onResume: () => void
}

// BackupCancelModal is what "Cancel" opens on an in-progress backup. The run
// is already paused by the time this renders, so the two outcomes are about
// what happens to the part that did land: keep it, or roll it back. Resuming
// is the escape hatch for a mis-click.
export function BackupCancelModal({
  storedCount, storedBytes, unit, busy, onRemove, onKeep, onResume,
}: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onResume() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [busy, onResume])

  const plural = storedCount === 1 ? unit : `${unit}s`
  const nothingStored = storedCount === 0

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70]">
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-2xl w-[26rem] max-w-[92vw] p-6 flex flex-col gap-4"
      >
        <div className="flex items-center gap-2">
          <MdWarningAmber className="text-amber-500 text-xl shrink-0" />
          <h3 className="text-base font-semibold text-gray-900 m-0">Cancel this backup?</h3>
        </div>

        <p className="text-sm text-gray-600 m-0 leading-relaxed">
          {nothingStored ? (
            <>The backup is paused and nothing has been stored yet.</>
          ) : (
            <>
              The backup is paused. <strong>{storedCount.toLocaleString()} {plural}</strong>{' '}
              ({formatBackupBytes(storedBytes)}) already made it into your storage — keep them, or
              remove them again?
            </>
          )}
        </p>

        <div className="flex flex-col gap-2">
          <button
            onClick={onRemove}
            disabled={busy || nothingStored}
            className="flex items-center gap-2 px-3 py-2.5 text-sm rounded-lg border border-red-200 text-red-600 hover:bg-red-50 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-default text-left"
          >
            {busy
              ? <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin shrink-0" />
              : <MdDeleteOutline className="text-base shrink-0" />}
            <span className="flex-1">
              <span className="block font-semibold">Remove what was backed up</span>
              <span className="block text-[11px] text-red-400">
                Deletes the partial backup and frees the storage again.
              </span>
            </span>
          </button>

          <button
            onClick={onKeep}
            disabled={busy}
            className="flex items-center gap-2 px-3 py-2.5 text-sm rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-default text-left"
          >
            <MdSaveAlt className="text-base shrink-0" />
            <span className="flex-1">
              <span className="block font-semibold">Keep them</span>
              <span className="block text-[11px] text-gray-400">
                Stops here; anything already backed up stays in your storage.
              </span>
            </span>
          </button>
        </div>

        <button
          onClick={onResume}
          disabled={busy}
          className="flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 bg-transparent border-0 cursor-pointer disabled:opacity-40 disabled:cursor-default"
        >
          <MdPlayArrow className="text-sm" /> Never mind — resume the backup
        </button>
      </div>
    </div>
  )
}
