import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  adminInterestInfiniteQueryOptions,
  interestFormSettingsQueryOptions,
  updateInterestFormSettings,
  provisionInterestSubmission,
} from '../../api/admin'
import { capacityQueryOptions } from '../../api/admin'
import { ApiError } from '../../api/client'
import { useNotification } from '../../context/NotificationContext'

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

function RouteComponent() {
  const queryClient = useQueryClient()
  const { notify } = useNotification()

  const { data, isLoading, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteQuery(adminInterestInfiniteQueryOptions)

  const { data: settings } = useQuery(interestFormSettingsQueryOptions)
  const { data: capacity } = useQuery(capacityQueryOptions)

  // Daily cap editing
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

  // Provision flow per submission
  const [provisioningId, setProvisioningId] = useState<string | null>(null)
  const [quotaBytes, setQuotaBytes] = useState(10 * GB)
  const [useCustom, setUseCustom] = useState(false)
  const [customGb, setCustomGb] = useState('')
  const [pendingProvisionId, setPendingProvisionId] = useState<string | null>(null)

  const effectiveQuota = useCustom ? Math.round((parseFloat(customGb) || 0) * GB) : quotaBytes

  const provisionMutation = useMutation({
    mutationFn: (id: string) => provisionInterestSubmission(id, effectiveQuota),
    onMutate: (id) => setPendingProvisionId(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'interest'] })
      setProvisioningId(null)
      setPendingProvisionId(null)
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

  const submissions = data?.pages.flatMap(p => p.items) ?? []

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-6 mt-0">Interest submissions</h2>

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

      {/* Provision quota picker (shown below the row when provisioning) */}
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
