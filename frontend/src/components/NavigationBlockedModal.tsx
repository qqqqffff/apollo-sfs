import { useEffect } from 'react'
import { MdArrowBack, MdLogout, MdWarningAmber } from 'react-icons/md'

interface Props {
  message: string
  // Leave anyway — the in-flight job is abandoned mid-transfer.
  onLeave: () => void
  // Stay put — the job keeps running.
  onStay: () => void
}

// Confirms leaving the file browser (a different top-level route, a page
// refresh, or closing the tab) while an upload or delete is still running —
// the job has no way to resume from where it left off once its request(s)
// are cut short mid-flight, unlike the Google/email backups (see
// api/backupSnapshot.ts), which persist enough to pick back up. Escape
// defaults to staying, same as the rest of this app's confirmation modals.
export function NavigationBlockedModal({ message, onLeave, onStay }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onStay() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onStay])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70]">
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-2xl w-[26rem] max-w-[92vw] p-6 flex flex-col gap-4"
      >
        <div className="flex items-center gap-2">
          <MdWarningAmber className="text-amber-500 text-xl shrink-0" />
          <h3 className="text-base font-semibold text-gray-900 m-0">Leave now?</h3>
        </div>

        <p className="text-sm text-gray-600 m-0 leading-relaxed">{message}</p>

        <div className="flex flex-col gap-2">
          <button
            onClick={onStay}
            className="flex items-center gap-2 px-3 py-2.5 text-sm rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 cursor-pointer transition-colors text-left"
          >
            <MdArrowBack className="text-base shrink-0" />
            <span className="font-semibold">Stay — let it finish</span>
          </button>

          <button
            onClick={onLeave}
            className="flex items-center justify-center gap-1.5 text-xs text-red-500 hover:text-red-600 bg-transparent border-0 cursor-pointer"
          >
            <MdLogout className="text-sm" /> Leave anyway
          </button>
        </div>
      </div>
    </div>
  )
}
