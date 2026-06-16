import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  adminInterestInfiniteQueryOptions,
  interestFormSettingsQueryOptions,
  updateInterestFormSettings,
  provisionInterestSubmission,
  capacityQueryOptions,
  listExpansionRequests,
  fulfillExpansionRequest,
  cancelExpansionRequest,
} from '../../api/admin'
import type { ExpansionRequestFilter } from '../../api/admin'
import { ApiError } from '../../api/client'
import { useNotification } from '../../context/NotificationContext'
import type { ServerExpansionRequest } from '../../types/api'

export const Route = createFileRoute('/_auth/admin/interest')({
  component: RouteComponent,
})

const GB = 1024 ** 3

const QUOTA_OPTIONS = [
  { label: '1 GB',   bytes: 1  * GB },
  { label: '5 GB',   bytes: 5  * GB },
  { label: '10 GB',  bytes: 10 * GB },
  { label: '25 GB',  bytes: 25 * GB },
  { label: '50 GB',  bytes: 50 * GB },
  { label: '100 GB', bytes: 100 * GB },
]

type Tab = 'interest' | 'expansion'

function RouteComponent() {
  const [activeTab, setActiveTab] = useState<Tab>('interest')

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-6 mt-0">Requests</h2>

      {/* Sub-tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {([
          { key: 'interest',  label: 'Interest Submissions' },
          { key: 'expansion', label: 'Expansion Requests' },
        ] as { key: Tab; label: string }[]).map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer ${
              activeTab === key
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'interest' ? <InterestTab /> : <ExpansionTab />}
    </div>
  )
}

// ── Interest Submissions tab ──────────────────────────────────────────────────

function InterestTab() {
  const queryClient = useQueryClient()
  const { notify } = useNotification()

  const { data, isLoading, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteQuery(adminInterestInfiniteQueryOptions)

  const { data: settings } = useQuery(interestFormSettingsQueryOptions)
  const { data: capacity } = useQuery(capacityQueryOptions)

  const [editingCap, setEditingCap] = useState(false)
  const [capInput, setCapInput] = useState('')

  const updateCapMutation = useMutation({
    mutationFn: () => updateInterestFormSettings(Number(capInput)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'interest', 'settings'] })
      setEditingCap(false)
      notify('success', 'Daily cap updated')
    },
    onError: (err) => {
      notify('error', err instanceof ApiError ? err.message : 'Failed to update cap')
    },
  })

  const [provisioningId, setProvisioningId] = useState<string | null>(null)
  const [quotaBytes, setQuotaBytes] = useState(10 * GB)
  const [useCustom, setUseCustom] = useState(false)
  const [customGb, setCustomGb] = useState('')
  const [grantAdmin, setGrantAdmin] = useState(false)
  const [pendingProvisionId, setPendingProvisionId] = useState<string | null>(null)

  const effectiveQuota = useCustom ? Math.round((parseFloat(customGb) || 0) * GB) : quotaBytes

  const provisionMutation = useMutation({
    mutationFn: (id: string) => provisionInterestSubmission(id, effectiveQuota, grantAdmin),
    onMutate: (id) => setPendingProvisionId(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'interest'] })
      setProvisioningId(null)
      setPendingProvisionId(null)
      setGrantAdmin(false)
      notify('success', 'Invitation sent')
    },
    onError: (err) => {
      notify('error', err instanceof ApiError ? err.message : 'Failed to provision account')
      setPendingProvisionId(null)
    },
  })

  const maxAvailableBytes = capacity?.max_available_bytes ?? null
  const quotaExceedsCapacity = maxAvailableBytes !== null && effectiveQuota > maxAvailableBytes

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (error)    return <p className="text-sm text-red-500">Failed to load submissions.</p>

  const submissions = data?.pages.flatMap(p => p.items ?? []) ?? []

  return (
    <div>
      {/* Settings bar */}
      <div className="mb-6 flex items-center gap-3 flex-wrap">
        <span className="text-sm text-gray-500">
          Daily cap:{' '}
          <span className="font-medium text-gray-800">{settings?.daily_cap ?? '—'}</span>
        </span>
        {editingCap ? (
          <form
            onSubmit={(e) => { e.preventDefault(); updateCapMutation.mutate() }}
            className="flex items-center gap-2"
          >
            <input
              type="number"
              min={1}
              max={100000}
              value={capInput}
              onChange={(e) => setCapInput(e.target.value)}
              placeholder="New cap"
              autoFocus
              className="w-24 border border-gray-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={updateCapMutation.isPending || !capInput}
              className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-md disabled:opacity-50 transition-colors cursor-pointer"
            >
              {updateCapMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditingCap(false)}
              className="px-3 py-1 text-xs text-gray-500 hover:text-gray-800 border border-gray-200 rounded-md transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            onClick={() => { setCapInput(String(settings?.daily_cap ?? 100)); setEditingCap(true) }}
            className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer bg-transparent border-0"
          >
            Edit cap
          </button>
        )}
      </div>

      {provisioningId && (
        <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl flex flex-col gap-3">
          <p className="text-sm font-medium text-blue-800">
            Choose storage quota for this account
          </p>
          {maxAvailableBytes !== null && (
            <p className="text-xs text-gray-500">
              Max available: {(maxAvailableBytes / GB).toFixed(1)} GB
              {quotaExceedsCapacity && (
                <span className="text-red-500 font-medium ml-2">Exceeds capacity</span>
              )}
            </p>
          )}
          <div className="flex items-center gap-2 flex-wrap">
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
                useCustom ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
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
          <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
            <input
              type="checkbox"
              checked={grantAdmin}
              onChange={(e) => setGrantAdmin(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 accent-blue-600 cursor-pointer"
            />
            <span className="text-xs text-gray-600">Grant admin access</span>
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={() => provisionMutation.mutate(provisioningId)}
              disabled={pendingProvisionId === provisioningId || (useCustom && effectiveQuota <= 0) || quotaExceedsCapacity}
              className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg disabled:opacity-50 transition-colors cursor-pointer"
            >
              {pendingProvisionId === provisioningId ? 'Sending invite…' : 'Send invite'}
            </button>
            <button
              onClick={() => setProvisioningId(null)}
              className="px-4 py-1.5 text-sm text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full min-w-200 text-sm border-collapse">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {['Name', 'Email', 'Storage', 'Use case', 'Submitted', 'Status', ''].map((h) => (
                <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {submissions.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400">
                  No submissions yet.
                </td>
              </tr>
            )}
            {submissions.map((sub) => (
              <tr key={sub.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3 text-gray-800 font-medium">{sub.name}</td>
                <td className="px-4 py-3 text-gray-600 text-xs">{sub.email}</td>
                <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{sub.desired_storage_gb} GB</td>
                <td className="px-4 py-3 text-gray-600 text-xs max-w-56">
                  <span className="line-clamp-2" title={sub.use_case}>{sub.use_case}</span>
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                  {new Date(sub.created_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  {sub.provisioned_at ? (
                    <span className="inline-block text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                      Provisioned
                    </span>
                  ) : (
                    <span className="inline-block text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                      Pending
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {!sub.provisioned_at && (
                    <button
                      onClick={() => {
                        setProvisioningId(sub.id)
                        setQuotaBytes(Math.min(sub.desired_storage_gb, 100) * GB)
                        setUseCustom(false)
                      }}
                      className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer bg-transparent border border-blue-200 hover:border-blue-400 rounded px-2 py-1 transition-colors"
                    >
                      Provision
                    </button>
                  )}
                </td>
              </tr>
            ))}
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

// ── Expansion Requests tab ────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  opened:    'bg-blue-100 text-blue-700',
  expanded:  'bg-violet-100 text-violet-700',
  completed: 'bg-green-100 text-green-700',
  expired:   'bg-gray-100 text-gray-500',
  refunded:  'bg-amber-100 text-amber-700',
}

function ExpansionTab() {
  const queryClient = useQueryClient()
  const { notify } = useNotification()

  const [filter, setFilter] = useState<ExpansionRequestFilter>({})
  const [cursor, setCursor] = useState<string | undefined>()

  // Filters UI state
  const [statusFilter, setStatusFilter] = useState('')
  const [fromFilter, setFromFilter]     = useState('')
  const [toFilter, setToFilter]         = useState('')

  const appliedFilter: ExpansionRequestFilter = {
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(fromFilter   ? { from: fromFilter }     : {}),
    ...(toFilter     ? { to: toFilter }         : {}),
    ...(cursor       ? { cursor }               : {}),
  }

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'expansion-requests', appliedFilter],
    queryFn: () => listExpansionRequests(appliedFilter),
  })

  // Fulfill
  const [pendingFulfillId, setPendingFulfillId] = useState<string | null>(null)
  const fulfillMutation = useMutation({
    mutationFn: (id: string) => fulfillExpansionRequest(id),
    onMutate: (id) => setPendingFulfillId(id),
    onSuccess: () => {
      setPendingFulfillId(null)
      queryClient.invalidateQueries({ queryKey: ['admin', 'expansion-requests'] })
      notify('success', 'Marked expanded — payment email sent to user')
    },
    onError: (err) => {
      setPendingFulfillId(null)
      notify('error', err instanceof ApiError ? err.message : 'Failed to complete allocation')
    },
  })

  // Cancel modal
  const [cancelTarget, setCancelTarget] = useState<ServerExpansionRequest | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [pendingCancelId, setPendingCancelId] = useState<string | null>(null)
  const cancelMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => cancelExpansionRequest(id, reason),
    onMutate: ({ id }) => setPendingCancelId(id),
    onSuccess: () => {
      setPendingCancelId(null)
      setCancelTarget(null)
      setCancelReason('')
      queryClient.invalidateQueries({ queryKey: ['admin', 'expansion-requests'] })
      notify('success', 'Request cancelled and deposit refunded')
    },
    onError: (err) => {
      setPendingCancelId(null)
      notify('error', err instanceof ApiError ? err.message : 'Failed to cancel request')
    },
  })

  const items = data?.items ?? []

  function applyFilters() {
    setCursor(undefined)
    setFilter(appliedFilter)
    refetch()
  }

  function resetFilters() {
    setStatusFilter('')
    setFromFilter('')
    setToFilter('')
    setCursor(undefined)
    setFilter({})
  }

  function planLabel(planId: string, storageType: string) {
    const labels: Record<string, string> = {
      '64gb': '64 GB', '128gb': '128 GB', '256gb': '256 GB',
      '512gb': '512 GB', '1tb': '1 TB',
    }
    return `${labels[planId] ?? planId} ${storageType.toUpperCase()}`
  }

  function formatBytes(b: number) {
    if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(1) + ' TB'
    if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GB'
    return (b / 1024 ** 2).toFixed(0) + ' MB'
  }

  function formatCents(cents: number, currency: string) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
  }

  return (
    <div>
      {/* Filters */}
      <div className="mb-5 flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500 font-medium">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
          >
            <option value="">All</option>
            <option value="opened">Opened</option>
            <option value="expanded">Expanded</option>
            <option value="completed">Completed</option>
            <option value="expired">Expired</option>
            <option value="refunded">Refunded</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500 font-medium">From</label>
          <input
            type="date"
            value={fromFilter}
            onChange={(e) => setFromFilter(e.target.value ? e.target.value + 'T00:00:00Z' : '')}
            className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500 font-medium">To</label>
          <input
            type="date"
            value={toFilter}
            onChange={(e) => setToFilter(e.target.value ? e.target.value + 'T23:59:59Z' : '')}
            className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          onClick={applyFilters}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors cursor-pointer"
        >
          Apply
        </button>
        <button
          onClick={resetFilters}
          className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg transition-colors cursor-pointer"
        >
          Reset
        </button>
      </div>

      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {error    && <p className="text-sm text-red-500">Failed to load expansion requests.</p>}

      {!isLoading && !error && (
        <>
          <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {['User', 'Server', 'Plan', 'Deposit', 'Pre-quota', 'Post-quota', 'Status', 'Created', 'Expires', ''].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-sm text-gray-400">
                      No expansion requests found.
                    </td>
                  </tr>
                )}
                {items.map((req) => (
                  <tr key={req.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-800">{req.username}</div>
                      <div className="text-xs text-gray-400">{req.user_email}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-xs">{req.server_name}</td>
                    <td className="px-4 py-3 text-gray-600 text-xs whitespace-nowrap">{planLabel(req.plan_id, req.storage_type)}</td>
                    <td className="px-4 py-3 text-gray-600 text-xs whitespace-nowrap">
                      {formatCents(req.deposit_amount_cents, req.currency)}
                      <span className="text-gray-400"> / {formatCents(req.full_price_cents, req.currency)}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{formatBytes(req.pre_quota_bytes)}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                      {req.post_quota_bytes != null ? formatBytes(req.post_quota_bytes) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full capitalize ${STATUS_COLORS[req.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {req.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                      {new Date(req.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                      {new Date(req.expires_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      {(req.status === 'opened' || req.status === 'expanded') && (
                        <div className="flex gap-2">
                          {req.status === 'opened' && (
                            <button
                              onClick={() => fulfillMutation.mutate(req.id)}
                              disabled={pendingFulfillId === req.id}
                              title="Verify server has capacity, then email user to pay remaining balance"
                              className="text-xs text-green-700 hover:text-green-900 border border-green-200 hover:border-green-400 bg-transparent rounded px-2 py-1 transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
                            >
                              {pendingFulfillId === req.id ? 'Marking…' : 'Mark Expanded'}
                            </button>
                          )}
                          {req.status === 'expanded' && (
                            <span className="text-xs text-violet-600 px-2 py-1 whitespace-nowrap" title={req.payment_due_at ? `Payment due: ${new Date(req.payment_due_at).toLocaleDateString()}` : undefined}>
                              Awaiting payment
                            </span>
                          )}
                          <button
                            onClick={() => { setCancelTarget(req); setCancelReason('') }}
                            className="text-xs text-red-600 hover:text-red-800 border border-red-200 hover:border-red-400 bg-transparent rounded px-2 py-1 transition-colors cursor-pointer whitespace-nowrap"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex gap-3 mt-3">
            {data?.next_token && (
              <button
                onClick={() => setCursor(data.next_token)}
                className="text-sm text-blue-600 hover:text-blue-700 cursor-pointer bg-transparent border-0"
              >
                Load more
              </button>
            )}
            {cursor && (
              <button
                onClick={() => setCursor(undefined)}
                className="text-sm text-gray-500 hover:text-gray-700 cursor-pointer bg-transparent border-0"
              >
                Back to first page
              </button>
            )}
          </div>
        </>
      )}

      {/* Cancel confirmation modal */}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4">
            <h3 className="text-base font-semibold text-gray-900 mb-1">Cancel expansion request</h3>
            <p className="text-sm text-gray-500 mb-4">
              This will issue a full deposit refund of{' '}
              <span className="font-medium text-gray-800">
                {formatCents(cancelTarget.deposit_amount_cents, cancelTarget.currency)}
              </span>{' '}
              to <span className="font-medium text-gray-800">{cancelTarget.username}</span> and
              send them a cancellation email. This action cannot be undone.
            </p>
            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-600 mb-1">Reason (required)</label>
              <textarea
                rows={3}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Explain why the request is being cancelled…"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => { setCancelTarget(null); setCancelReason('') }}
                className="px-4 py-2 text-sm text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg transition-colors cursor-pointer"
              >
                Go back
              </button>
              <button
                type="button"
                disabled={!cancelReason.trim() || pendingCancelId === cancelTarget.id}
                onClick={() => cancelMutation.mutate({ id: cancelTarget.id, reason: cancelReason.trim() })}
                className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg disabled:opacity-50 transition-colors cursor-pointer"
              >
                {pendingCancelId === cancelTarget.id ? 'Cancelling…' : 'Confirm cancellation'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
