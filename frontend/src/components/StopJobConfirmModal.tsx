import { useEffect } from 'react'
import { MdPlayArrow, MdStop, MdWarningAmber } from 'react-icons/md'

interface Props {
  title: string
  message: string
  // Stop the run where it is.
  onStop: () => void
  // Never mind — carry on where it left off.
  onResume: () => void
}

// StopJobConfirmModal is what "Cancel" opens on a job that has no
// meaningful "keep or remove the partial result" choice — unlike a
// cancelled upload or backup, a cancelled delete can't be rolled back (the
// removed part is already gone), so this just confirms stopping. The run is
// already paused by the time this renders (same pattern as
// BackupCancelModal); Resume is the escape hatch for a mis-click.
export function StopJobConfirmModal({ title, message, onStop, onResume }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onResume() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onResume])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70]">
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-2xl w-[26rem] max-w-[92vw] p-6 flex flex-col gap-4"
      >
        <div className="flex items-center gap-2">
          <MdWarningAmber className="text-amber-500 text-xl shrink-0" />
          <h3 className="text-base font-semibold text-gray-900 m-0">{title}</h3>
        </div>

        <p className="text-sm text-gray-600 m-0 leading-relaxed">{message}</p>

        <div className="flex flex-col gap-2">
          <button
            onClick={onStop}
            className="flex items-center gap-2 px-3 py-2.5 text-sm rounded-lg border border-red-200 text-red-600 hover:bg-red-50 cursor-pointer transition-colors text-left"
          >
            <MdStop className="text-base shrink-0" />
            <span className="font-semibold">Stop here</span>
          </button>

          <button
            onClick={onResume}
            className="flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 bg-transparent border-0 cursor-pointer"
          >
            <MdPlayArrow className="text-sm" /> Never mind — resume
          </button>
        </div>
      </div>
    </div>
  )
}
