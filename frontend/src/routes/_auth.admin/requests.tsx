import { createFileRoute } from '@tanstack/react-router'
import { useState, useCallback } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MdContentCopy, MdCheck, MdRefresh } from 'react-icons/md'
import {
  adminInvitationsInfiniteQueryOptions,
  adminInterestInfiniteQueryOptions,
  interestFormSettingsQueryOptions,
  updateInterestFormSettings,
  provisionInterestSubmission,
  capacityQueryOptions,
  infrastructureQueryOptions,
  createInvitation,
  revokeInvitation,
  resendInvitation,
} from '../../api/admin'
import { STORAGE_PLANS } from '../../api/billing'
import { ApiError } from '../../api/client'
import { useNotification } from '../../context/NotificationContext'

export const Route = createFileRoute('/_auth/admin/requests')({
  component: RouteComponent,
})

const RESEND_COOLDOWN_MS = 30_000
const GB = 1024 ** 3

// Quota chips mirror the standardized capacities offered in the storage
// upgrade panel (STORAGE_PLANS), so invitations and provisioned accounts use
// the same ladder users can later purchase.
const QUOTA_OPTIONS = STORAGE_PLANS.map((p) => ({ label: p.label, bytes: p.addBytes }))

function formatQuota(bytes: number): string {
  if (bytes >= 1024 * GB) return `${(bytes / (1024 * GB)).toFixed(bytes % (1024 * GB) === 0 ? 0 : 1)} TB`
  return `${(bytes / GB).toFixed(bytes % GB === 0 ? 0 : 1)} GB`
}

function RouteComponent() {
  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-6 mt-0">Requests</h2>
      <section className="mb-10">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4 pb-2 border-b border-gray-200">
          Invitations
        </h3>
        <InvitationsSection />
      </section>
      <section>
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4 pb-2 border-b border-gray-200">
          Access requests
        </h3>
        <InterestSection />
      </section>
    </div>
  )
}

// ── Quota picker (shared by both sections) ────────────────────────────────────

function QuotaPicker({
  quotaBytes, setQuotaBytes, useCustom, setUseCustom, customGb, setCustomGb,
}: {
  quotaBytes: number
  setQuotaBytes: (b: number) => void
  useCustom: boolean
  setUseCustom: (v: boolean) => void
  customGb: string
  setCustomGb: (v: string) => void
}) {
  return (
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
  )
}

// ── Invitations section ───────────────────────────────────────────────────────

function InvitationsSection() {
  const queryClient = useQueryClient()
  const { data, isLoading, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteQuery(adminInvitationsInfiniteQueryOptions)
  const { data: capacity } = useQuery(capacityQueryOptions)
  const { data: infraData } = useQuery(infrastructureQueryOptions)

  // Group drives by node for the drive picker
  const nodeMap = new Map<string, { hostname: string; drives: NonNullable<typeof infraData>['drives'][number][] }>()
  for (const d of infraData?.drives ?? []) {
    const key = d.node_hostname
    if (!nodeMap.has(key)) nodeMap.set(key, { hostname: key, drives: [] })
    nodeMap.get(key)!.drives.push(d)
  }
  const nodeGroups = Array.from(nodeMap.values())

  const [email, setEmail] = useState('')
  const [quotaBytes, setQuotaBytes] = useState(QUOTA_OPTIONS[0].bytes)
  const [customGb, setCustomGb] = useState('')
  const [useCustom, setUseCustom] = useState(false)
  const [grantAdmin, setGrantAdmin] = useState(false)
  const [grantPremium, setGrantPremium] = useState(false)
  const [selectedDriveId, setSelectedDriveId] = useState<string>('')
  const { notify } = useNotification()
  const [createError, setCreateError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [lastResent, setLastResent] = useState<Record<string, number>>({})
  const [pendingResendId, setPendingResendId] = useState<string | null>(null)

  const effectiveQuota = useCustom
    ? Math.round((parseFloat(customGb) || 0) * GB)
    : quotaBytes

  const createMutation = useMutation({
    mutationFn: () => createInvitation(email, effectiveQuota, grantAdmin, grantPremium, selectedDriveId || undefined),
    onSuccess: () => {
      setEmail('')
      setGrantAdmin(false)
      setGrantPremium(false)
      setSelectedDriveId('')
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

  const selectedDriveSummary = infraData?.drives.find(d => d.drive_id === selectedDriveId)
  const selectedDriveAvailableBytes = selectedDriveSummary
    ? Math.max(0, selectedDriveSummary.capacity_bytes - selectedDriveSummary.allocated_quota_bytes)
    : null

  const maxAvailableBytes = selectedDriveAvailableBytes ?? capacity?.max_available_bytes ?? null
  const maxAvailableGb = maxAvailableBytes !== null ? maxAvailableBytes / GB : null
  const quotaExceedsCapacity = maxAvailableBytes !== null && effectiveQuota > maxAvailableBytes

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (error) return <p className="text-sm text-red-500">Failed to load invitations.</p>

  const invitations = data?.pages.flatMap(p => p.items) ?? []

  return (
    <div>
      {maxAvailableGb !== null && (
        <div className="mb-4 flex items-center gap-2 text-xs text-gray-500">
          <span className="font-medium text-gray-700">
            {selectedDriveSummary ? `Max quota on ${selectedDriveSummary.drive_label}:` : 'Max quota available:'}
          </span>
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

        <QuotaPicker
          quotaBytes={quotaBytes} setQuotaBytes={setQuotaBytes}
          useCustom={useCustom} setUseCustom={setUseCustom}
          customGb={customGb} setCustomGb={setCustomGb}
        />
        {nodeGroups.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-gray-500">Drive assignment:</span>
            <div className="flex flex-wrap gap-4">
              {nodeGroups.map(node => (
                <div key={node.hostname} className="flex flex-col gap-1 min-w-36">
                  <span className="text-xs font-medium text-gray-500">{node.hostname}</span>
                  {node.drives.map(drive => (
                    <button
                      key={drive.drive_id}
                      type="button"
                      onClick={() => setSelectedDriveId(drive.drive_id === selectedDriveId ? '' : drive.drive_id)}
                      className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-xs text-left transition-colors cursor-pointer ${
                        selectedDriveId === drive.drive_id
                          ? 'bg-blue-50 border-blue-400 text-blue-700'
                          : 'bg-white border-gray-200 text-gray-700 hover:border-gray-400'
                      }`}
                    >
                      <span className="flex-1 truncate">{drive.drive_label}</span>
                      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                        drive.drive_type === 'nvme'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}>
                        {drive.drive_type === 'nvme' ? 'Fast' : 'Slow'}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            {!selectedDriveId && (
              <span className="text-xs text-gray-400">No drive selected — best-fit chosen automatically</span>
            )}
          </div>
        )}

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
                    {formatQuota(inv.initial_quota_bytes)}
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

// ── Access requests (interest form submissions) ───────────────────────────────

function InterestSection() {
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
  const [quotaBytes, setQuotaBytes] = useState(QUOTA_OPTIONS[0].bytes)
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
          <QuotaPicker
            quotaBytes={quotaBytes} setQuotaBytes={setQuotaBytes}
            useCustom={useCustom} setUseCustom={setUseCustom}
            customGb={customGb} setCustomGb={setCustomGb}
          />
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
                        // Snap the requested size onto the standardized ladder:
                        // the smallest plan that covers it, else the largest plan.
                        const requested = sub.desired_storage_gb * GB
                        const covering = QUOTA_OPTIONS.find((o) => o.bytes >= requested)
                        setQuotaBytes((covering ?? QUOTA_OPTIONS[QUOTA_OPTIONS.length - 1]).bytes)
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
