import { createFileRoute } from '@tanstack/react-router'
import { useState, useCallback } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MdContentCopy, MdCheck, MdRefresh } from 'react-icons/md'
import {
  adminInvitationsInfiniteQueryOptions,
  capacityQueryOptions,
  createInvitation,
  revokeInvitation,
  resendInvitation,
} from '../../api/admin'
import { ApiError } from '../../api/client'
import { useNotification } from '../../context/NotificationContext'

export const Route = createFileRoute('/_auth/admin/invitations')({
  component: RouteComponent,
})

const RESEND_COOLDOWN_MS = 30_000
const GB = 1024 ** 3

const QUOTA_OPTIONS = [
  { label: '1 GB',  bytes: 1 * GB },
  { label: '5 GB',  bytes: 5 * GB },
  { label: '10 GB', bytes: 10 * GB },
  { label: '25 GB', bytes: 25 * GB },
  { label: '50 GB', bytes: 50 * GB },
  { label: '100 GB', bytes: 100 * GB },
]

function RouteComponent() {
  const queryClient = useQueryClient()
  const { data, isLoading, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteQuery(adminInvitationsInfiniteQueryOptions)
  const { data: capacity } = useQuery(capacityQueryOptions)

  const [email, setEmail] = useState('')
  const [quotaBytes, setQuotaBytes] = useState(10 * GB)
  const [customGb, setCustomGb] = useState('')
  const [useCustom, setUseCustom] = useState(false)
  const [grantAdmin, setGrantAdmin] = useState(false)
  const [grantPremium, setGrantPremium] = useState(false)
  const { notify } = useNotification()
  const [createError, setCreateError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [lastResent, setLastResent] = useState<Record<string, number>>({})
  const [pendingResendId, setPendingResendId] = useState<string | null>(null)

  const effectiveQuota = useCustom
    ? Math.round((parseFloat(customGb) || 0) * GB)
    : quotaBytes

  const createMutation = useMutation({
    mutationFn: () => createInvitation(email, effectiveQuota, grantAdmin, grantPremium),
    onSuccess: () => {
      setEmail('')
      setGrantAdmin(false)
      setGrantPremium(false)
      setCreateError(null)
      queryClient.invalidateQueries({ queryKey: ['admin', 'invitations'] })
      notify('success', 'Invitation sent')
    },
    onError: (err) => {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to create invitation')
    },
  })

  const revokeMutation = useMutation({
    mutationFn: revokeInvitation,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'invitations'] }),
    onError: () => notify('error', 'Failed to revoke invitation'),
  })

  const resendMutation = useMutation({
    mutationFn: resendInvitation,
    onMutate: (id) => setPendingResendId(id),
    onSuccess: (_data, id) => {
      setLastResent((prev) => ({ ...prev, [id]: Date.now() }))
      queryClient.invalidateQueries({ queryKey: ['admin', 'invitations'] })
      notify('success', 'Invitation email resent successfully')
      setPendingResendId(null)
    },
    onError: () => {
      notify('error', 'Failed to resend invitation')
      setPendingResendId(null)
    },
  })

  const handleCopy = useCallback((id: string, url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000)
    })
  }, [])

  function resendCooldownRemaining(id: string): number {
    const last = lastResent[id]
    if (!last) return 0
    return Math.max(0, RESEND_COOLDOWN_MS - (Date.now() - last))
  }

  const maxAvailableBytes = capacity?.max_available_bytes ?? null
  const maxAvailableGb = maxAvailableBytes !== null ? maxAvailableBytes / GB : null
  const quotaExceedsCapacity = maxAvailableBytes !== null && effectiveQuota > maxAvailableBytes

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (error) return <p className="text-sm text-red-500">Failed to load invitations.</p>

  const invitations = data?.pages.flatMap(p => p.items) ?? []

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-6 mt-0">Invitations</h2>

      {maxAvailableGb !== null && (
        <div className="mb-4 flex items-center gap-2 text-xs text-gray-500">
          <span className="font-medium text-gray-700">Max quota available:</span>
          <span>{maxAvailableGb.toFixed(1)} GB</span>
          {quotaExceedsCapacity && (
            <span className="text-red-500 font-medium">
              Selected quota exceeds available drive capacity
            </span>
          )}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          setCreateError(null)
          createMutation.mutate()
        }}
        className="flex flex-col gap-3 mb-6"
      >
        <div className="flex gap-2">
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button
            type="submit"
            disabled={createMutation.isPending || (useCustom && effectiveQuota <= 0) || quotaExceedsCapacity}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg disabled:opacity-50 cursor-pointer transition-colors"
          >
            {createMutation.isPending ? 'Sending…' : 'Invite'}
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 shrink-0">Storage quota:</span>
          {QUOTA_OPTIONS.map((opt) => (
            <button
              key={opt.bytes}
              type="button"
              onClick={() => { setUseCustom(false); setQuotaBytes(opt.bytes) }}
              className={`px-2.5 py-1 text-xs rounded-md border cursor-pointer transition-colors ${
                !useCustom && quotaBytes === opt.bytes
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
              }`}
            >
              {opt.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setUseCustom(true)}
            className={`px-2.5 py-1 text-xs rounded-md border cursor-pointer transition-colors ${
              useCustom
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
            }`}
          >
            Custom
          </button>
          {useCustom && (
            <div className="flex items-center gap-1">
              <input
                type="number"
                min="0.1"
                step="0.1"
                placeholder="GB"
                value={customGb}
                onChange={(e) => setCustomGb(e.target.value)}
                className="w-20 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <span className="text-xs text-gray-400">GB</span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={grantAdmin}
              onChange={(e) => {
                setGrantAdmin(e.target.checked)
                if (e.target.checked) setGrantPremium(false)
              }}
              className="w-4 h-4 rounded border-gray-300 accent-blue-600 cursor-pointer"
            />
            <span className="text-xs text-gray-600">Grant admin access</span>
          </label>
          <label className={`flex items-center gap-2 select-none ${grantAdmin ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
            <input
              type="checkbox"
              checked={grantAdmin ? true : grantPremium}
              disabled={grantAdmin}
              onChange={(e) => setGrantPremium(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 accent-blue-600 cursor-pointer"
            />
            <span className="text-xs text-gray-600">
              Grant premium{grantAdmin ? ' (included with admin)' : ''}
            </span>
          </label>
        </div>
      </form>
      {createError && <p className="text-sm text-red-500 mb-4">{createError}</p>}

      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full min-w-160 text-sm border-collapse">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {['Email', 'Quota', 'Expires', 'Status', ''].map((h) => (
                <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {invitations.map((inv) => {
              const isExpired = !inv.accepted_at && !inv.revoked_at && new Date() > new Date(inv.token_expires_at)
              const status = inv.accepted_at ? 'Accepted' : inv.revoked_at ? 'Revoked' : isExpired ? 'Expired' : 'Pending'
              const isPending = status === 'Pending'
              const cooldown = resendCooldownRemaining(inv.id)
              const onCooldown = cooldown > 0
              return (
                <tr key={inv.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 text-gray-800">{inv.email}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {(inv.initial_quota_bytes / GB).toFixed(0)} GB
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {new Date(inv.token_expires_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${
                      status === 'Accepted' ? 'bg-green-100 text-green-700' :
                      status === 'Revoked'  ? 'bg-gray-100 text-gray-500' :
                      status === 'Expired'  ? 'bg-red-50 text-red-500' :
                                             'bg-amber-100 text-amber-700'
                    }`}>
                      {status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {(isPending || isExpired) && (
                      <div className="flex items-center gap-2">
                        {isPending && inv.invitation_url && (
                          <button
                            onClick={() => handleCopy(inv.id, inv.invitation_url!)}
                            title="Copy invite link"
                            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 cursor-pointer bg-transparent border border-gray-200 hover:border-gray-400 rounded px-2 py-1 transition-colors"
                          >
                            {copiedId === inv.id
                              ? <><MdCheck className="text-green-500" /> Copied</>
                              : <><MdContentCopy /> Copy link</>
                            }
                          </button>
                        )}
                        <button
                          onClick={() => {
                            if (!onCooldown) resendMutation.mutate(inv.id)
                          }}
                          disabled={onCooldown || pendingResendId === inv.id}
                          title={onCooldown ? `Wait ${Math.ceil(cooldown / 1000)}s before resending` : 'Resend invite email'}
                          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-blue-600 cursor-pointer bg-transparent border border-gray-200 hover:border-blue-300 rounded px-2 py-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <MdRefresh className={pendingResendId === inv.id ? 'animate-spin' : ''} />
                          {pendingResendId === inv.id ? 'Sending…' : 'Resend'}
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`Revoke invitation for ${inv.email}?`)) {
                              revokeMutation.mutate(inv.id)
                            }
                          }}
                          className="text-xs text-red-500 hover:text-red-700 cursor-pointer bg-transparent border border-red-200 hover:border-red-400 rounded px-2 py-1 transition-colors"
                        >
                          Revoke
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {hasNextPage && (
        <button
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="mt-3 text-sm text-blue-600 hover:text-blue-700 cursor-pointer bg-transparent border-0 disabled:opacity-50"
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
