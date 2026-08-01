import { useState } from 'react'
import { MdClose, MdAdminPanelSettings, MdWorkspacePremium, MdPerson } from 'react-icons/md'
import type { AccountGroup } from './GroupBadge'

export interface RoleAssignConfirm {
  role: AccountGroup
  reason: string
  premiumExpiresAt?: string
  blockFuturePremium?: boolean
}

interface Props {
  username: string
  currentRole: AccountGroup
  onConfirm: (input: RoleAssignConfirm) => void
  onClose: () => void
  isPending: boolean
}

const ROLE_OPTIONS: { value: AccountGroup; label: string; icon: React.ComponentType<{ className?: string }>; activeClass: string }[] = [
  { value: 'admin', label: 'Admin', icon: MdAdminPanelSettings, activeClass: 'bg-purple-100 text-purple-700 border-purple-300' },
  { value: 'premium', label: 'Premium', icon: MdWorkspacePremium, activeClass: 'bg-amber-100 text-amber-700 border-amber-300' },
  { value: 'user', label: 'User', icon: MdPerson, activeClass: 'bg-gray-100 text-gray-600 border-gray-300' },
]

// RoleAssignModal lets an admin assign one of the three roles to a user, with
// a required reason (shown in the affected user's notifications), an
// optional Premium trial expiry, and — when demoting an active Premium user
// to a regular user — a checkbox to block future Premium purchases.
export function RoleAssignModal({ username, currentRole, onConfirm, onClose, isPending }: Props) {
  const [role, setRole] = useState<AccountGroup>(currentRole)
  const [reason, setReason] = useState('')
  const [premiumExpiresAt, setPremiumExpiresAt] = useState('')
  const [blockFuturePremium, setBlockFuturePremium] = useState(false)

  const losingPremium = currentRole === 'premium' && role !== 'premium'
  const showBlockCheckbox = losingPremium && role === 'user'
  const canSubmit = reason.trim().length > 0 && !(role === currentRole && role !== 'premium')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    onConfirm({
      role,
      reason: reason.trim(),
      premiumExpiresAt: role === 'premium' && premiumExpiresAt ? new Date(premiumExpiresAt).toISOString() : undefined,
      blockFuturePremium: showBlockCheckbox ? blockFuturePremium : undefined,
    })
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
          <h3 className="text-sm font-semibold text-gray-800">
            Edit role — <span className="text-blue-600">{username}</span>
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0"
          >
            <MdClose className="text-lg" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-700">Role</label>
            <div className="grid grid-cols-3 gap-2">
              {ROLE_OPTIONS.map(({ value, label, icon: Icon, activeClass }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setRole(value)}
                  className={`flex flex-col items-center gap-1 px-2 py-2 rounded-lg border text-xs font-medium cursor-pointer transition-colors ${
                    role === value ? activeClass : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <Icon className="text-lg" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {losingPremium && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              This user's active Premium membership will be cancelled — any real PayPal subscription is
              cancelled too, and a mandatory email explaining why is sent to them.
            </p>
          )}

          {role === 'premium' && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-700">
                Trial expires <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="date"
                value={premiumExpiresAt}
                onChange={(e) => setPremiumExpiresAt(e.target.value)}
                min={new Date().toISOString().slice(0, 10)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-800 w-44 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-400">Leave blank for permanent Premium access.</p>
            </div>
          )}

          {showBlockCheckbox && (
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={blockFuturePremium}
                onChange={(e) => setBlockFuturePremium(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 accent-blue-600 cursor-pointer"
              />
              <span className="text-sm text-gray-600">Prevent this user from purchasing a new Premium subscription</span>
            </label>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-700">
              Reason <span className="text-gray-400 font-normal">— shown in the user's notifications</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              required
              placeholder="Why is this role being assigned?"
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-800 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

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
              className="px-4 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed bg-blue-600 hover:bg-blue-700 text-white"
            >
              {isPending ? 'Saving…' : 'Save role'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
