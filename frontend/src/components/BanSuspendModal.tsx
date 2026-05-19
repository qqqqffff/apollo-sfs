import { useState } from 'react'
import { MdClose, MdBlock, MdLockClock } from 'react-icons/md'
import { VIOLATION_CODES } from '../types/api'

type ModalMode = 'ban' | 'suspend'

interface Props {
  username: string
  mode: ModalMode
  onConfirm: (violationCode: string, comments: string, hours?: number) => void
  onClose: () => void
  isPending: boolean
}

export function BanSuspendModal({ username, mode, onConfirm, onClose, isPending }: Props) {
  const [violationCode, setViolationCode] = useState('')
  const [comments, setComments] = useState('')
  const [hours, setHours] = useState(24)
  const [hoursError, setHoursError] = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!violationCode) return

    if (mode === 'suspend') {
      const h = Number(hours)
      if (!Number.isInteger(h) || h < 1) {
        setHoursError('Duration must be a positive whole number of hours')
        return
      }
      onConfirm(violationCode, comments, h)
    } else {
      onConfirm(violationCode, comments)
    }
  }

  const isBan = mode === 'ban'
  const accentClass = isBan ? 'text-red-600' : 'text-amber-600'
  const btnClass = isBan
    ? 'bg-red-600 hover:bg-red-700 text-white'
    : 'bg-amber-500 hover:bg-amber-600 text-white'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            {isBan
              ? <MdBlock className={`text-lg ${accentClass}`} />
              : <MdLockClock className={`text-lg ${accentClass}`} />
            }
            <h3 className="text-sm font-semibold text-gray-800">
              {isBan ? 'Ban' : 'Suspend'}{' '}
              <span className={accentClass}>{username}</span>
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0"
          >
            <MdClose className="text-lg" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-4">
          {isBan && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              All of this user's files will be <strong>permanently deleted</strong> and their quota will be freed immediately.
            </p>
          )}

          {/* Violation code */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-700">Violation code</label>
            <select
              value={violationCode}
              onChange={(e) => setViolationCode(e.target.value)}
              required
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">Select a TOS violation…</option>
              {Object.entries(VIOLATION_CODES).map(([code, label]) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
          </div>

          {/* Comments */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-700">
              Comments <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <textarea
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              rows={3}
              placeholder="Additional context for this action…"
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-800 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Duration — suspensions only */}
          {!isBan && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-700">Duration (hours)</label>
              <input
                type="number"
                min={1}
                step={1}
                value={hours}
                onChange={(e) => { setHours(Number(e.target.value)); setHoursError('') }}
                required
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-800 w-36 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {hoursError && <p className="text-xs text-red-500">{hoursError}</p>}
              <p className="text-xs text-gray-400">
                Suspension ends in {hours > 0 ? (hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h`) : '—'}
              </p>
            </div>
          )}

          {/* Actions */}
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
              disabled={!violationCode || isPending}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${btnClass}`}
            >
              {isPending
                ? (isBan ? 'Banning…' : 'Suspending…')
                : (isBan ? 'Ban user' : 'Suspend user')
              }
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
