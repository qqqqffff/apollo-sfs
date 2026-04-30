import { useEffect, useState } from 'react'
import { MdDeleteForever } from 'react-icons/md'

const COOKIE_KEY = 'skipDeleteConfirm'

// Returns true when the stored username matches the currently logged-in user,
// meaning this user has opted out of the confirmation modal this session.
export function readSkipDeleteCookie(username: string): boolean {
  const entry = document.cookie.split(';').find((c) => c.trim().startsWith(`${COOKIE_KEY}=`))
  if (!entry) return false
  return entry.trim().slice(COOKIE_KEY.length + 1) === username
}

// Stores the username as the cookie value (session cookie — no max-age).
function setSkipDeleteCookie(username: string) {
  document.cookie = `${COOKIE_KEY}=${encodeURIComponent(username)}; path=/; SameSite=Strict`
}

// Expires the cookie immediately. Call on logout and session expiry so the
// preference does not carry over to a different account or a new session.
export function clearSkipDeleteCookie() {
  document.cookie = `${COOKIE_KEY}=; path=/; SameSite=Strict; max-age=0`
}

interface Props {
  name: string
  username: string   // used to tie the cookie to this account
  onConfirm: () => void
  onCancel: () => void
}

export function DeleteConfirmModal({ name, username, onConfirm, onCancel }: Props) {
  const [dontShowAgain, setDontShowAgain] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  function handleConfirm() {
    if (dontShowAgain) setSkipDeleteCookie(username)
    onConfirm()
  }

  return (
    <div
      onClick={onCancel}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-96 max-w-[92vw] p-6 flex flex-col gap-5"
      >
        <div className="flex items-start gap-3">
          <MdDeleteForever className="text-red-500 text-2xl shrink-0 mt-0.5" />
          <div>
            <h3 className="text-base font-semibold text-gray-900 m-0 mb-1">Delete permanently?</h3>
            <p className="text-sm text-gray-500 m-0">
              <span className="font-medium text-gray-700">"{name}"</span> will be permanently deleted and cannot be recovered.
            </p>
          </div>
        </div>

        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 accent-blue-600 cursor-pointer"
          />
          <span className="text-sm text-gray-500">Don't show this confirmation again</span>
        </label>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            className="px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium cursor-pointer transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
