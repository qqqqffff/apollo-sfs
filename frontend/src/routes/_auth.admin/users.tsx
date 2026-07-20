import { createFileRoute, useNavigate, Link } from '@tanstack/react-router'
import { Fragment, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MdCheck, MdClose, MdEdit, MdInfoOutline, MdBlock, MdLockClock, MdLockOpen, MdStorage,
  MdOpenInNew, MdDns, MdExpandMore, MdExpandLess, MdSearch, MdArrowUpward, MdArrowDownward, MdUnfoldMore,
  MdAdd, MdDeleteOutline,
} from 'react-icons/md'
import {
  getAdminAuditLogs,
  getAdminUserStorage,
  infrastructureQueryOptions,
  logImpersonationAccess,
  searchAdminUsers,
  updateUserStorageAllocations,
  updateUsername,
  banUser,
  suspendUser,
  pardonUser,
} from '../../api/admin'
import type { AdminUserStorageAllocation, SortDir, StorageAllocationsViolation, StorageTier, UserRoleFilter, UserSortKey } from '../../api/admin'
import { ApiError } from '../../api/client'
import { meQueryOptions } from '../../api/me'
import type { AuditLog, User, UserBan } from '../../types/api'
import { useNotification } from '../../context/NotificationContext'
import { useImpersonation } from '../../context/ImpersonationContext'
import { BanSuspendModal } from '../../components/BanSuspendModal'
import { AccountBadges } from '../../components/GroupBadge'
import { AllocationChangeBreakdown } from '../../components/AllocationChangeBreakdown'

const PAGE_SIZE = 25

const SORT_DEFAULT_DIR: Record<UserSortKey, SortDir> = {
  username: 'asc',
  email: 'asc',
  role: 'desc',
  created_at: 'desc',
  last_seen_at: 'desc',
}

export const Route = createFileRoute('/_auth/admin/users')({
  // focus: username to auto-expand when arriving from the admin Orders page.
  validateSearch: (search: Record<string, unknown>): { focus?: string } => ({
    focus: typeof search.focus === 'string' ? search.focus : undefined,
  }),
  component: RouteComponent,
})

const GB = 1024 ** 3
const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000

function isActive(user: User): boolean {
  if (!user.last_seen_at) return false
  return Date.now() - new Date(user.last_seen_at).getTime() < ACTIVE_THRESHOLD_MS
}

// ── Action label + colour ─────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  impersonation_access: 'Account accessed by admin',
  file_uploaded:        'File uploaded',
  file_upload_started:  'File upload started',
  folder_created:       'Folder created',
  file_favorited:       'File favorited',
  folder_favorited:     'Folder favorited',
  file_unfavorited:     'File unfavorited',
  folder_unfavorited:   'Folder unfavorited',
  file_deleted:         'File deleted',
  file_renamed:         'File renamed',
  folder_renamed:       'Folder renamed',
  storage_allocations_updated: 'Storage allocations updated',
}

const ACTION_COLOURS: Record<string, string> = {
  impersonation_access: 'bg-orange-100 text-orange-700',
  file_uploaded:        'bg-green-100 text-green-700',
  file_upload_started:  'bg-blue-100 text-blue-700',
  folder_created:       'bg-blue-100 text-blue-700',
  file_favorited:       'bg-yellow-100 text-yellow-700',
  folder_favorited:     'bg-yellow-100 text-yellow-700',
  file_unfavorited:     'bg-gray-100 text-gray-500',
  folder_unfavorited:   'bg-gray-100 text-gray-500',
  file_deleted:         'bg-red-100 text-red-700',
  file_renamed:         'bg-purple-100 text-purple-700',
  folder_renamed:       'bg-purple-100 text-purple-700',
  storage_allocations_updated: 'bg-sky-100 text-sky-700',
}

// ── Audit log modal ───────────────────────────────────────────────────────────

function AuditLogModal({ username, onClose }: { username: string; onClose: () => void }) {
  const { data, isLoading, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteQuery({
      queryKey: ['admin', 'audit', username],
      queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
        getAdminAuditLogs(username, pageParam),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last) => last.next_token || undefined,
    })
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  const logs: AuditLog[] = data?.pages.flatMap((p) => p.items) ?? []

  function toggleBreakdown(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-800">
            Audit log — <span className="text-blue-600">{username}</span>
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0"
          >
            <MdClose className="text-lg" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-3">
          {isLoading && <p className="text-sm text-gray-400 py-4 text-center">Loading…</p>}
          {error && <p className="text-sm text-red-500 py-4 text-center">Failed to load audit logs.</p>}
          {!isLoading && logs.length === 0 && (
            <p className="text-sm text-gray-400 py-4 text-center">No audit records yet.</p>
          )}

          <ul className="space-y-2">
            {logs.map((log) => (
              <li key={log.id} className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${ACTION_COLOURS[log.action] ?? 'bg-gray-100 text-gray-600'}`}
                    >
                      {ACTION_LABELS[log.action] ?? log.action}
                    </span>
                    {log.actor_username !== log.target_username && (
                      <span className="text-xs text-orange-500 font-medium">
                        by {log.actor_username}
                      </span>
                    )}
                  </div>
                  {log.resource_name && (
                    <p className="text-xs text-gray-600 mt-0.5 truncate">{log.resource_name}</p>
                  )}
                  {log.details && (
                    <>
                      <button
                        onClick={() => toggleBreakdown(log.id)}
                        className="text-[10px] font-medium text-blue-500 hover:text-blue-700 bg-transparent border-0 p-0 cursor-pointer mt-0.5"
                      >
                        {expandedIds.has(log.id) ? 'Hide breakdown' : 'Show breakdown'}
                      </button>
                      {expandedIds.has(log.id) && <AllocationChangeBreakdown details={log.details} />}
                    </>
                  )}
                </div>
                <time className="text-xs text-gray-400 whitespace-nowrap shrink-0 mt-0.5">
                  {new Date(log.created_at).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>

          {hasNextPage && (
            <button
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="mt-3 w-full text-sm text-blue-600 hover:text-blue-700 cursor-pointer bg-transparent border-0 disabled:opacity-50"
            >
              {isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Role badge ────────────────────────────────────────────────────────────────

function RoleBadge({ user }: { user: User }) {
  return <AccountBadges user={user} />
}

// ── Per-user storage detail (expandable subtable) ─────────────────────────────

function fmtGB(bytes: number): string {
  return `${(bytes / GB).toFixed(2)} GB`
}

const TIER: Record<'nvme' | 'hdd', { label: string; chip: string; bar: string }> = {
  nvme: { label: 'Fast',     chip: 'bg-emerald-100 text-emerald-700', bar: 'bg-emerald-500' },
  hdd:  { label: 'Standard', chip: 'bg-sky-100 text-sky-700',         bar: 'bg-sky-500' },
}

// DraftAllocation is one row of the in-progress edit: an existing allocation
// (driveId matches one already in s.allocations) or a newly-added one (added
// via the "same server, other tier" or "different server" controls).
interface DraftAllocation {
  driveId: string
  serverId: string
  serverName: string
  driveType: 'nvme' | 'hdd'
  gbText: string
  usedBytes: number
  isPrimary: boolean
}

// localRowError validates a draft row's GB text against its used bytes,
// mirroring the server's own floor check (used_exceeds_quota) so most
// mistakes are caught before Save is even clicked.
function localRowError(d: DraftAllocation): string | null {
  const n = Number(d.gbText)
  if (d.gbText.trim() === '' || !Number.isFinite(n) || n < 0) return 'Enter a valid GB amount'
  if (Math.round(n * GB) < d.usedBytes) return `Must be at least ${fmtGB(d.usedBytes)} (already used)`
  return null
}

function describeViolation(v: StorageAllocationsViolation): string {
  switch (v.code) {
    case 'used_exceeds_quota':
      return `Must be at least ${fmtGB(v.used_bytes ?? 0)} (already used)`
    case 'insufficient_capacity':
      return `Only ${fmtGB(v.max_bytes ?? 0)} available${v.drive_label ? ` on ${v.drive_label}` : ''}`
    case 'removal_blocked':
      return `Cannot remove — ${fmtGB(v.used_bytes ?? 0)} used`
    default:
      return 'Invalid allocation'
  }
}

// StorageDetails renders inline below a user row: their allocation (quota) vs
// what they've used, grouped by server, with the tier on each drive.
// "Edit" switches the allocation list into an editor: each row's GB becomes a
// text field, a server that only has one tier allocated gets a button to add
// its other tier, and a separate control adds an allocation on a server the
// user isn't on yet. Save processes every change atomically.
function StorageDetails({ username }: { username: string }) {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const { data: s, isLoading, error } = useQuery({
    queryKey: ['admin', 'user-storage', username],
    queryFn: () => getAdminUserStorage(username),
  })
  const [editing, setEditing] = useState(false)
  const { data: infraData } = useQuery({ ...infrastructureQueryOptions, enabled: editing })
  const [draft, setDraft] = useState<DraftAllocation[]>([])
  const [reason, setReason] = useState('')
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [addServerId, setAddServerId] = useState('')
  const [addTier, setAddTier] = useState<'nvme' | 'hdd' | ''>('')
  const [addGb, setAddGb] = useState('')

  const saveMutation = useMutation({
    mutationFn: () => updateUserStorageAllocations(username, {
      allocations: draft.map((d) => ({ drive_id: d.driveId, quota_bytes: Math.round(Number(d.gbText) * GB) })),
      reason: reason.trim() || undefined,
    }),
    onSuccess: (resp) => {
      queryClient.setQueryData(['admin', 'user-storage', username], resp)
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      setEditing(false)
      setRowErrors({})
      notify('success', 'Storage allocations updated')
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && Array.isArray(err.body.violations)) {
        const next: Record<string, string> = {}
        for (const v of err.body.violations as StorageAllocationsViolation[]) {
          next[v.drive_id] = describeViolation(v)
        }
        setRowErrors(next)
      } else {
        notify('error', 'Failed to update storage allocations')
      }
    },
  })

  if (isLoading) return <p className="text-sm text-gray-400 px-5 py-4">Loading storage…</p>
  if (error || !s) return <p className="text-sm text-red-500 px-5 py-4">Failed to load storage details.</p>

  // Group allocations by server; each server lists the drive(s) holding the user's space.
  const servers = new Map<string, { name: string; state: string; isPrimary: boolean; nodes: AdminUserStorageAllocation[] }>()
  for (const a of s.allocations) {
    const g = servers.get(a.server_id) ?? { name: a.server_name, state: a.server_state, isPrimary: false, nodes: [] }
    g.nodes.push(a)
    if (a.is_primary) g.isPrimary = true
    servers.set(a.server_id, g)
  }

  function startEdit() {
    setDraft(s!.allocations.map((a) => ({
      driveId: a.drive_id, serverId: a.server_id, serverName: a.server_name,
      driveType: a.drive_type, gbText: (a.quota_bytes / GB).toFixed(2),
      usedBytes: a.used_bytes, isPrimary: a.is_primary,
    })))
    setReason('')
    setRowErrors({})
    setAddServerId(''); setAddTier(''); setAddGb('')
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
    setRowErrors({})
  }

  function removeRow(driveId: string) {
    setDraft((prev) => prev.filter((d) => d.driveId !== driveId))
  }

  function updateRowGb(driveId: string, gbText: string) {
    setDraft((prev) => prev.map((d) => (d.driveId === driveId ? { ...d, gbText } : d)))
    setRowErrors((prev) => {
      if (!(driveId in prev)) return prev
      const next = { ...prev }
      delete next[driveId]
      return next
    })
  }

  function addOtherTier(serverId: string, serverName: string, otherTier: 'nvme' | 'hdd') {
    const drive = infraData?.drives.find((dr) => dr.server_id === serverId && dr.drive_type === otherTier && dr.drive_is_active)
    if (!drive) return
    setDraft((prev) => [...prev, {
      driveId: drive.drive_id, serverId, serverName, driveType: otherTier, gbText: '0', usedBytes: 0, isPrimary: false,
    }])
  }

  function confirmAddServer() {
    const drive = infraData?.drives.find((dr) => dr.server_id === addServerId && dr.drive_type === addTier)
    if (!drive) return
    setDraft((prev) => [...prev, {
      driveId: drive.drive_id, serverId: drive.server_id, serverName: drive.server_name,
      driveType: drive.drive_type, gbText: addGb || '0', usedBytes: 0, isPrimary: false,
    }])
    setAddServerId(''); setAddTier(''); setAddGb('')
  }

  // Servers the user has zero current allocations on, for the "add on a
  // different server" dropdown — diffed client-side against the infra list,
  // no dedicated backend endpoint needed.
  const draftServerIds = new Set(draft.map((d) => d.serverId))
  const eligibleServers = infraData
    ? [...new Map(
        infraData.drives
          .filter((d) => d.server_is_active && !draftServerIds.has(d.server_id))
          .map((d) => [d.server_id, { id: d.server_id, name: d.server_name }] as const),
      ).values()]
    : []
  const eligibleTiersForAddServer = infraData
    ? [...new Set(infraData.drives.filter((d) => d.server_id === addServerId && d.drive_is_active).map((d) => d.drive_type))]
    : []

  const draftHasError = draft.length === 0 || draft.some((d) => (rowErrors[d.driveId] ?? localRowError(d)) !== null)

  // Group the draft by server for rendering in edit mode.
  const draftByServer = new Map<string, { serverName: string; rows: DraftAllocation[] }>()
  for (const d of draft) {
    const g = draftByServer.get(d.serverId) ?? { serverName: d.serverName, rows: [] }
    g.rows.push(d)
    draftByServer.set(d.serverId, g)
  }

  return (
    <div className="px-5 py-4 bg-gray-50/70 space-y-4">
      {/* Active expansion requests → quick link to the requests page */}
      {s.active_request_count > 0 && (
        <Link
          to="/admin/requests"
          className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 no-underline hover:bg-amber-100 transition-colors"
        >
          <span className="text-sm font-medium text-amber-800">
            {s.active_request_count} active expansion request{s.active_request_count === 1 ? '' : 's'}
          </span>
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 whitespace-nowrap">
            View requests <MdOpenInNew className="text-sm" />
          </span>
        </Link>
      )}

      {/* Allocation summary + Edit toggle */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-gray-600">
        <span>Allocated: <span className="font-semibold text-gray-800">{fmtGB(s.quota_bytes)}</span></span>
        <span>Used: <span className="font-semibold text-gray-800">{fmtGB(s.used_bytes)}</span></span>
        <span className="text-emerald-700">Fast (NVMe): <span className="font-semibold">{fmtGB(s.nvme_bytes)}</span></span>
        <span className="text-sky-700">Standard (HDD): <span className="font-semibold">{fmtGB(s.hdd_bytes)}</span></span>
        {!editing && (
          <button
            onClick={startEdit}
            className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 cursor-pointer bg-transparent border border-blue-200 hover:border-blue-400 rounded px-2 py-1 transition-colors"
          >
            <MdEdit className="text-sm" /> Edit
          </button>
        )}
      </div>

      {!editing ? (
        s.allocations.length === 0 ? (
          <p className="text-sm text-gray-400">No storage allocated to this user.</p>
        ) : (
          <div className="space-y-3">
            {[...servers.values()].map((srv) => (
              <div key={srv.name} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                {/* Server that has storage allocated to the user */}
                <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 bg-gray-50">
                  <MdDns className="text-gray-400 text-base shrink-0" />
                  <span className="text-sm font-semibold text-gray-800">{srv.name}</span>
                  <span className="text-xs text-gray-400">{srv.state}</span>
                  {srv.isPrimary && (
                    <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-blue-50 text-blue-600 rounded">
                      Primary
                    </span>
                  )}
                </div>

                {/* Drive(s) owning the allocated space, with tier + allocation vs used */}
                <div className="divide-y divide-gray-50">
                  {srv.nodes.map((n) => {
                    const tier = TIER[n.drive_type]
                    const pct = n.quota_bytes > 0 ? Math.min(100, Math.round((n.used_bytes / n.quota_bytes) * 100)) : 0
                    return (
                      <div key={n.drive_id} className="px-4 py-2.5">
                        <div className="flex items-center justify-between gap-3 mb-1.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-xs text-gray-400 shrink-0">Node</span>
                            <span className="text-sm text-gray-700 truncate">
                              {n.node_hostname || <span className="text-gray-300">unassigned</span>}
                            </span>
                            <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${tier.chip}`}>
                              {tier.label}
                            </span>
                          </div>
                          <span className="text-xs text-gray-500 whitespace-nowrap">
                            {fmtGB(n.used_bytes)} used of {fmtGB(n.quota_bytes)}
                          </span>
                        </div>
                        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${tier.bar}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="space-y-3">
          {[...draftByServer.entries()].map(([serverId, group]) => {
            const missingTier: 'nvme' | 'hdd' | null =
              group.rows.length === 1 ? (group.rows[0].driveType === 'nvme' ? 'hdd' : 'nvme') : null
            const canAddMissingTier = missingTier
              ? !!infraData?.drives.find((dr) => dr.server_id === serverId && dr.drive_type === missingTier && dr.drive_is_active)
              : false
            return (
              <div key={serverId} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 bg-gray-50">
                  <MdDns className="text-gray-400 text-base shrink-0" />
                  <span className="text-sm font-semibold text-gray-800">{group.serverName}</span>
                </div>
                <div className="divide-y divide-gray-50">
                  {group.rows.map((d) => {
                    const tier = TIER[d.driveType]
                    const rowError = rowErrors[d.driveId] ?? localRowError(d)
                    return (
                      <div key={d.driveId} className="px-4 py-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${tier.chip}`}>
                              {tier.label}
                            </span>
                            {d.isPrimary && (
                              <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-blue-50 text-blue-600 rounded">
                                Primary
                              </span>
                            )}
                            <span className="text-xs text-gray-400">Used: {fmtGB(d.usedBytes)}</span>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <input
                              type="text"
                              inputMode="decimal"
                              value={d.gbText}
                              onChange={(e) => updateRowGb(d.driveId, e.target.value)}
                              className="w-20 border border-gray-300 rounded px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                            <span className="text-xs text-gray-400">GB</span>
                            <button
                              onClick={() => removeRow(d.driveId)}
                              disabled={d.usedBytes > 0}
                              title={d.usedBytes > 0 ? `Cannot remove — ${fmtGB(d.usedBytes)} used` : 'Remove allocation'}
                              className="text-gray-300 hover:text-red-500 disabled:opacity-30 disabled:hover:text-gray-300 cursor-pointer disabled:cursor-not-allowed bg-transparent border-0 p-0"
                            >
                              <MdDeleteOutline className="text-base" />
                            </button>
                          </div>
                        </div>
                        {rowError && <p className="text-xs text-red-500 m-0 mt-1">{rowError}</p>}
                      </div>
                    )
                  })}
                </div>
                {missingTier && canAddMissingTier && (
                  <button
                    onClick={() => addOtherTier(serverId, group.serverName, missingTier)}
                    className="w-full flex items-center justify-center gap-1 px-4 py-2 text-xs text-blue-600 hover:bg-blue-50 cursor-pointer bg-transparent border-0 border-t border-gray-100 transition-colors"
                  >
                    <MdAdd className="text-sm" /> Add {TIER[missingTier].label} allocation on {group.serverName}
                  </button>
                )}
              </div>
            )
          })}

          {/* Add allocation on a different server */}
          <div className="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider m-0 mb-2">Add allocation on another server</p>
            {!infraData ? (
              <p className="text-xs text-gray-400 m-0">Loading servers…</p>
            ) : eligibleServers.length === 0 ? (
              <p className="text-xs text-gray-400 m-0">No servers available</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={addServerId}
                  onChange={(e) => {
                    const id = e.target.value
                    setAddServerId(id)
                    const tiers = [...new Set(infraData.drives.filter((d) => d.server_id === id && d.drive_is_active).map((d) => d.drive_type))]
                    setAddTier(tiers[0] ?? '')
                  }}
                  className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-700 cursor-pointer focus:outline-none"
                >
                  <option value="">Select a server…</option>
                  {eligibleServers.map((srv) => (
                    <option key={srv.id} value={srv.id}>{srv.name}</option>
                  ))}
                </select>
                {addServerId && (
                  <>
                    <div className="flex items-center gap-1 border border-gray-200 rounded-lg p-0.5">
                      {(['nvme', 'hdd'] as const).filter((t) => eligibleTiersForAddServer.includes(t)).map((t) => (
                        <button
                          key={t}
                          onClick={() => setAddTier(t)}
                          className={`px-2 py-1 text-xs rounded-md cursor-pointer border-0 transition-colors ${
                            addTier === t ? 'bg-blue-600 text-white' : 'bg-transparent text-gray-600 hover:bg-gray-100'
                          }`}
                        >
                          {TIER[t].label}
                        </button>
                      ))}
                    </div>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={addGb}
                      onChange={(e) => setAddGb(e.target.value)}
                      placeholder="GB"
                      className="w-20 border border-gray-300 rounded px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      onClick={confirmAddServer}
                      disabled={!addTier || !addGb || !Number.isFinite(Number(addGb)) || Number(addGb) < 0}
                      title="Add this allocation"
                      className="inline-flex items-center justify-center text-green-600 hover:text-green-800 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer bg-transparent border-0 p-0"
                    >
                      <MdCheck className="text-lg" />
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Reason + Save/Cancel */}
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional, shown to the user)"
            rows={2}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={cancelEdit}
              className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={() => saveMutation.mutate()}
              disabled={draftHasError || saveMutation.isPending}
              className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50 cursor-pointer"
            >
              {saveMutation.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sortable column header ────────────────────────────────────────────────────

function SortableTh({
  label, sortKey, sort, dir, onSort,
}: {
  label: string
  sortKey: UserSortKey
  sort: UserSortKey
  dir: SortDir
  onSort: (key: UserSortKey) => void
}) {
  const active = sort === sortKey
  return (
    <th
      onClick={() => onSort(sortKey)}
      className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:text-gray-700 transition-colors"
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          dir === 'asc' ? <MdArrowUpward className="text-xs" /> : <MdArrowDownward className="text-xs" />
        ) : (
          <MdUnfoldMore className="text-xs text-gray-300" />
        )}
      </span>
    </th>
  )
}

// ── Search + role filter + pagination bar ─────────────────────────────────────

function UsersListControls({
  search, onSearch, role, onRole, servers, serverId, onServerId, tiers, onToggleTier, page, pageCount, onPage,
}: {
  search: string
  onSearch: (v: string) => void
  role: UserRoleFilter | ''
  onRole: (v: UserRoleFilter | '') => void
  servers: { id: string; name: string }[]
  serverId: string
  onServerId: (v: string) => void
  tiers: Set<StorageTier>
  onToggleTier: (t: StorageTier) => void
  page: number
  pageCount: number
  onPage: (p: number) => void
}) {
  const [draft, setDraft] = useState(search)
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <div className="relative">
        <MdSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSearch(draft.trim()) }}
          onBlur={() => onSearch(draft.trim())}
          placeholder="Search username or email…"
          className="border border-gray-200 rounded-lg pl-8 pr-3 py-1.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>
      <select
        value={role}
        onChange={(e) => onRole(e.target.value as UserRoleFilter | '')}
        className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-700 cursor-pointer focus:outline-none"
      >
        <option value="">All roles</option>
        <option value="admin">Admin</option>
        <option value="premium">Premium</option>
        <option value="user">User</option>
      </select>
      <select
        value={serverId}
        onChange={(e) => onServerId(e.target.value)}
        className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-700 cursor-pointer focus:outline-none"
      >
        <option value="">All servers</option>
        {servers.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
      <div className="flex items-center gap-3 border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-700">
        {(['nvme', 'hdd'] as const).map((t) => (
          <label key={t} className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={tiers.has(t)}
              onChange={() => onToggleTier(t)}
              className="cursor-pointer"
            />
            {TIER[t].label}
          </label>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-2 text-sm text-gray-500">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          className="px-2 py-1 border border-gray-200 rounded disabled:opacity-40 cursor-pointer bg-white hover:bg-gray-50"
        >
          ‹
        </button>
        <span>Page {page} of {Math.max(pageCount, 1)}</span>
        <button
          onClick={() => onPage(page + 1)}
          disabled={page >= pageCount}
          className="px-2 py-1 border border-gray-200 rounded disabled:opacity-40 cursor-pointer bg-white hover:bg-gray-50"
        >
          ›
        </button>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type BanModal = { username: string; mode: 'ban' | 'suspend' }

function RouteComponent() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const { impersonate } = useImpersonation()
  const { data: me } = useQuery(meQueryOptions)

  const { focus } = Route.useSearch()
  // Pre-filter to the focused username (arriving from the Orders page's "View
  // in Users" link) so that user is reliably on page 1 regardless of sort.
  const [search, setSearch] = useState(focus ?? '')
  const [role, setRole] = useState<UserRoleFilter | ''>('')
  const [serverId, setServerId] = useState('')
  const [tiers, setTiers] = useState<Set<StorageTier>>(new Set())
  const [sort, setSort] = useState<UserSortKey>('created_at')
  const [dir, setDir] = useState<SortDir>('desc')
  const [page, setPage] = useState(1)

  function toggleTier(t: StorageTier) {
    setTiers((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t); else next.add(t)
      return next
    })
    setPage(1)
  }

  // Server dropdown options for the storage-tier/server filter — reuses the
  // same infra fetch the per-user storage editor uses, deduped by server_id
  // (a server can have multiple drives across nodes).
  const { data: infraData } = useQuery(infrastructureQueryOptions)
  const serverOptions = infraData
    ? [...new Map(
        infraData.drives
          .filter((d) => d.server_is_active)
          .map((d) => [d.server_id, { id: d.server_id, name: d.server_name }] as const),
      ).values()].sort((a, b) => a.name.localeCompare(b.name))
    : []

  const tiersArray = [...tiers]
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'users', { search, role, serverId, tiers: tiersArray, sort, dir, page }],
    queryFn: () => searchAdminUsers({
      search, role: role || undefined, server_id: serverId || undefined,
      tiers: tiersArray.length ? tiersArray : undefined, sort, dir, page, page_size: PAGE_SIZE,
    }),
  })
  const pageCount = data ? Math.ceil(data.total / PAGE_SIZE) : 1

  function handleSort(key: UserSortKey) {
    if (key === sort) {
      setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSort(key)
      setDir(SORT_DEFAULT_DIR[key])
    }
    setPage(1)
  }

  const [auditUser, setAuditUser] = useState<string | null>(null)
  const [expandedUser, setExpandedUser] = useState<string | null>(focus ?? null)
  const [banModal, setBanModal] = useState<BanModal | null>(null)

  function viewUserFiles(u: User) {
    impersonate(u)
    logImpersonationAccess(u.username).catch(() => {})
    navigate({ to: '/client', search: { file: undefined, folder: undefined } })
  }

  const [editingUsername, setEditingUsername] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const renameMutation = useMutation({
    mutationFn: ({ username, newUsername }: { username: string; newUsername: string }) =>
      updateUsername(username, newUsername),
    onSuccess: (_data, { username }) => {
      setEditingUsername(null)
      setEditValue('')
      setEditError(null)
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      if (username === me?.username) {
        queryClient.invalidateQueries({ queryKey: ['me'] })
      }
    },
    onError: (err: Error) => {
      setEditError(err.message ?? 'Failed to rename user')
    },
  })

  const banMutation = useMutation({
    mutationFn: ({ username, violationCode, comments }: { username: string; violationCode: string; comments: string }) =>
      banUser(username, violationCode, comments),
    onSuccess: () => {
      setBanModal(null)
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'bans'] })
      notify('success', 'User banned and files deleted')
    },
    onError: () => notify('error', 'Failed to ban user'),
  })

  const suspendMutation = useMutation({
    mutationFn: ({ username, violationCode, comments, hours }: { username: string; violationCode: string; comments: string; hours: number }) =>
      suspendUser(username, violationCode, comments, hours),
    onSuccess: () => {
      setBanModal(null)
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'bans'] })
      notify('success', 'User suspended')
    },
    onError: () => notify('error', 'Failed to suspend user'),
  })

  const pardonMutation = useMutation({
    mutationFn: (username: string) => pardonUser(username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'bans'] })
      notify('success', 'User pardoned')
    },
    onError: () => notify('error', 'Failed to pardon user'),
  })

  function startEdit(username: string) {
    setEditingUsername(username)
    setEditValue(username)
    setEditError(null)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function cancelEdit() {
    setEditingUsername(null)
    setEditValue('')
    setEditError(null)
  }

  function confirmEdit(username: string) {
    const trimmed = editValue.trim()
    if (trimmed.length < 3) return
    if (trimmed === username) { cancelEdit(); return }
    renameMutation.mutate({ username, newUsername: trimmed })
  }

  function handleBanConfirm(violationCode: string, comments: string, hours?: number) {
    if (!banModal) return
    if (banModal.mode === 'ban') {
      banMutation.mutate({ username: banModal.username, violationCode, comments })
    } else {
      suspendMutation.mutate({ username: banModal.username, violationCode, comments, hours: hours! })
    }
  }

  const users = data?.items ?? []

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-6 mt-0">Users</h2>

      <UsersListControls
        search={search} onSearch={(v) => { setSearch(v); setPage(1) }}
        role={role} onRole={(v) => { setRole(v); setPage(1) }}
        servers={serverOptions}
        serverId={serverId} onServerId={(v) => { setServerId(v); setPage(1) }}
        tiers={tiers} onToggleTier={toggleTier}
        page={page} pageCount={pageCount} onPage={setPage}
      />

      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {error != null && <p className="text-sm text-red-500">Failed to load users.</p>}

      {data && (
      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full min-w-225 text-sm border-collapse">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <SortableTh label="Username" sortKey="username" sort={sort} dir={dir} onSort={handleSort} />
              <SortableTh label="Email" sortKey="email" sort={sort} dir={dir} onSort={handleSort} />
              <SortableTh label="Role" sortKey="role" sort={sort} dir={dir} onSort={handleSort} />
              <SortableTh label="Created" sortKey="created_at" sort={sort} dir={dir} onSort={handleSort} />
              <SortableTh label="Last seen" sortKey="last_seen_at" sort={sort} dir={dir} onSort={handleSort} />
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">No users found.</td></tr>
            )}
            {users.map((u) => {
              const active = isActive(u)
              const editing = editingUsername === u.username
              const ban = u.active_ban as UserBan | null | undefined
              const isBanned = ban?.ban_type === 'banned'
              const isSuspended = ban?.ban_type === 'suspended'

              return (
                <Fragment key={u.username}>
                <tr className={`hover:bg-gray-50 transition-colors ${isBanned ? 'bg-red-50/40' : isSuspended ? 'bg-amber-50/40' : ''}`}>
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {editing ? (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1">
                          <input
                            ref={inputRef}
                            type="text"
                            value={editValue}
                            onChange={(e) => { setEditValue(e.target.value); setEditError(null) }}
                            className="border border-gray-300 rounded px-2 py-0.5 text-sm w-36 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') confirmEdit(u.username)
                              if (e.key === 'Escape') cancelEdit()
                            }}
                          />
                          <button
                            onClick={() => confirmEdit(u.username)}
                            disabled={editValue.trim().length < 3 || renameMutation.isPending}
                            title="Confirm"
                            className="text-green-600 hover:text-green-800 disabled:opacity-40 cursor-pointer bg-transparent border-0 p-0"
                          >
                            <MdCheck className="text-base" />
                          </button>
                          <button
                            onClick={cancelEdit}
                            title="Cancel"
                            className="text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 p-0"
                          >
                            <MdClose className="text-base" />
                          </button>
                        </div>
                        {editError && (
                          <span className="text-xs text-red-500">{editError}</span>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span
                          title={active ? 'Active in last 5 min' : undefined}
                          className={`inline-block w-2 h-2 rounded-full shrink-0 ${active ? 'bg-green-500' : 'bg-gray-200'}`}
                        />
                        <button
                          onClick={() => viewUserFiles(u)}
                          title="View files as this user"
                          className="font-medium text-gray-900 hover:text-blue-600 cursor-pointer bg-transparent border-0 p-0 transition-colors"
                        >
                          {u.username}
                        </button>
                        <button
                          onClick={() => startEdit(u.username)}
                          title="Edit username"
                          className="text-gray-300 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0 transition-colors"
                        >
                          <MdEdit className="text-sm" />
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{u.email}</td>
                  <td className="px-4 py-3">
                    <RoleBadge user={u} />
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {new Date(u.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setExpandedUser((cur) => (cur === u.username ? null : u.username))}
                        title={editing ? undefined : 'Storage details'}
                        className={`inline-flex items-center gap-0.5 cursor-pointer bg-transparent border-0 p-0 transition-colors ${
                          expandedUser === u.username ? 'text-blue-600' : 'text-gray-400 hover:text-blue-600'
                        }`}
                      >
                        <MdStorage className="text-base" />
                        {expandedUser === u.username
                          ? <MdExpandLess className="text-base" />
                          : <MdExpandMore className="text-base" />}
                      </button>
                      <button
                        onClick={() => setAuditUser(u.username)}
                        title="View audit log"
                        className="text-gray-400 hover:text-blue-600 cursor-pointer bg-transparent border-0 p-0 transition-colors"
                      >
                        <MdInfoOutline className="text-base" />
                      </button>

                      {/* Ban / suspend / pardon */}
                      {ban ? (
                        <button
                          onClick={() => {
                            if (confirm(`Pardon ${u.username}? This will lift their ${ban.ban_type === 'banned' ? 'ban' : 'suspension'}.`))
                              pardonMutation.mutate(u.username)
                          }}
                          disabled={pardonMutation.isPending && pardonMutation.variables === u.username}
                          title="Pardon user"
                          className="inline-flex items-center gap-1 text-xs text-green-600 hover:text-green-800 cursor-pointer bg-transparent border border-green-200 hover:border-green-400 rounded px-2 py-1 transition-colors disabled:opacity-40"
                        >
                          <MdLockOpen className="text-sm" />
                          Pardon
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => setBanModal({ username: u.username, mode: 'suspend' })}
                            title="Suspend user"
                            className="text-amber-500 hover:text-amber-700 cursor-pointer bg-transparent border-0 p-0 transition-colors"
                          >
                            <MdLockClock className="text-base" />
                          </button>
                          <button
                            onClick={() => setBanModal({ username: u.username, mode: 'ban' })}
                            title="Ban user"
                            className="text-red-400 hover:text-red-700 cursor-pointer bg-transparent border-0 p-0 transition-colors"
                          >
                            <MdBlock className="text-base" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                {expandedUser === u.username && (
                  <tr>
                    <td colSpan={6} className="p-0 border-t border-gray-100">
                      <StorageDetails username={u.username} />
                    </td>
                  </tr>
                )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      )}

      {auditUser && (
        <AuditLogModal username={auditUser} onClose={() => setAuditUser(null)} />
      )}

      {banModal && (
        <BanSuspendModal
          username={banModal.username}
          mode={banModal.mode}
          onConfirm={handleBanConfirm}
          onClose={() => setBanModal(null)}
          isPending={banMutation.isPending || suspendMutation.isPending}
        />
      )}
    </div>
  )
}
