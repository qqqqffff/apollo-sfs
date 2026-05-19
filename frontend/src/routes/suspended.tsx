import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MdBlock, MdLockClock, MdHome } from 'react-icons/md'
import { logout } from '../api/auth'
import { AppIcon } from '../components/AppIcon'
import { VIOLATION_CODES } from '../types/api'
import type { AccountRestriction } from '../types/api'

export const Route = createFileRoute('/suspended')({
  component: RouteComponent,
})

function readRestriction(): AccountRestriction | null {
  try {
    const raw = sessionStorage.getItem('apollo_restriction')
    return raw ? (JSON.parse(raw) as AccountRestriction) : null
  } catch {
    return null
  }
}

function RouteComponent() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const restriction = readRestriction()

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSettled: () => {
      sessionStorage.removeItem('apollo_restriction')
      queryClient.clear()
      navigate({ to: '/login' })
    },
  })

  const isBanned = restriction?.error === 'banned'
  const violationLabel = restriction
    ? (VIOLATION_CODES[restriction.violation_code] ?? restriction.violation_code)
    : 'Policy violation'

  let expiresLabel = ''
  if (!isBanned && restriction?.expires_at) {
    expiresLabel = new Date(restriction.expires_at).toLocaleString()
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-200 w-full max-w-md p-8 flex flex-col items-center gap-6">
        <div className="flex items-center gap-2">
          <AppIcon size={28} />
          <span className="font-semibold text-gray-900 text-base tracking-tight">Apollo SFS</span>
        </div>

        <div className={`rounded-full p-4 ${isBanned ? 'bg-red-100' : 'bg-amber-100'}`}>
          {isBanned
            ? <MdBlock className="text-4xl text-red-600" />
            : <MdLockClock className="text-4xl text-amber-600" />
          }
        </div>

        <div className="text-center space-y-1">
          <h1 className="text-lg font-semibold text-gray-900">
            {isBanned ? 'Account Permanently Banned' : 'Account Suspended'}
          </h1>
          <p className="text-sm text-gray-500">
            {isBanned
              ? 'Your account has been permanently banned and all files have been deleted.'
              : 'Your account has been temporarily suspended.'}
          </p>
        </div>

        <div className="w-full bg-gray-50 rounded-xl border border-gray-200 divide-y divide-gray-200 text-sm">
          <div className="px-4 py-3">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-0.5">Reason</p>
            <p className="text-gray-800">{violationLabel}</p>
          </div>
          {restriction?.comments && (
            <div className="px-4 py-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-0.5">Comments</p>
              <p className="text-gray-700">{restriction.comments}</p>
            </div>
          )}
          {!isBanned && expiresLabel && (
            <div className="px-4 py-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-0.5">Suspended until</p>
              <p className="text-gray-800">{expiresLabel}</p>
            </div>
          )}
        </div>

        <button
          onClick={() => logoutMutation.mutate()}
          disabled={logoutMutation.isPending}
          className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-700 transition-colors disabled:opacity-50 cursor-pointer"
        >
          <MdHome className="text-base" />
          {logoutMutation.isPending ? 'Signing out…' : 'Return to home'}
        </button>
      </div>
    </div>
  )
}
