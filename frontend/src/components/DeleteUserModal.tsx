import { useState } from 'react'
import { MdClose, MdDeleteForever } from 'react-icons/md'

interface Props {
  username: string
  onConfirm: (reason: string) => void
  onClose: () => void
  isPending: boolean
}

// DeleteUserModal confirms permanent account deletion: a required reason
// (sent to the user in a mandatory email) and an explicit acknowledgment
// checkbox that the action is permanent and destroys all of the user's
// files. Mirrors BanSuspendModal/DeleteConfirmModal's layout.
export function DeleteUserModal({ username, onConfirm, onClose, isPending }: Props) {
  const [reason, setReason] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)

  const canSubmit = reason.trim().length > 0 && acknowledged

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    onConfirm(reason.trim())
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <MdDeleteForever className="text-lg text-red-600" />
            <h3 className="text-sm font-semibold text-gray-800">
              Delete <span className="text-red-600">{username}</span>
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0"
          >
            <MdClose className="text-lg" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-4">
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            This is <strong>permanent</strong>. {username}'s account and all of their files will be
            deleted and cannot be recovered.
          </p>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-700">
              Reason <span className="text-gray-400 font-normal">— sent to the user in a required email</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              required
              placeholder="Why is this account being deleted?"
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-800 resize-none focus:outline-none focus:ring-2 focus:ring-red-500"
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 accent-red-600 cursor-pointer"
            />
            <span className="text-sm text-gray-600">
              I understand this is permanent and all of {username}'s files will be deleted
            </span>
          </label>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 cursor-pointer bg-transparent border border-gray-200 hover:border-gray-400 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit || isPending}
              className="px-4 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed bg-red-600 hover:bg-red-700 text-white"
            >
              {isPending ? 'Deleting…' : 'Delete user'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
