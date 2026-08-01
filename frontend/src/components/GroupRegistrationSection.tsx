import { useCallback, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MdAdd,
  MdCheck,
  MdContentCopy,
  MdKeyboardArrowDown,
  MdKeyboardArrowUp,
  MdUnfoldMore,
} from 'react-icons/md'
import {
  registrationGroupsInfiniteQueryOptions,
  getRegistrationGroup,
  deactivateRegistrationGroup,
  deleteRegistrationGroup,
  type RegistrationGroupSummary,
  type RegistrationSlotType,
} from '../api/registrationGroups'
import { ApiError } from '../api/client'
import { useNotification } from '../context/NotificationContext'

const GB = 1024 ** 3

export function formatSlotQuota(bytes: number): string {
  if (bytes >= 1024 * GB) return `${(bytes / (1024 * GB)).toFixed(bytes % (1024 * GB) === 0 ? 0 : 1)} TB`
  return `${(bytes / GB).toFixed(bytes % GB === 0 ? 0 : 1)} GB`
}

export function tierLabel(driveType: 'nvme' | 'hdd'): string {
  return driveType === 'nvme' ? 'Fast (NVMe)' : 'Standard (HDD)'
}

type GroupStatus = 'active' | 'inactive' | 'expired'

function groupStatus(g: RegistrationGroupSummary): GroupStatus {
  if (!g.is_active) return 'inactive'
  if (g.expires_at && new Date(g.expires_at) < new Date()) return 'expired'
  return 'active'
}

type SortKey = 'created_at' | 'name' | 'expires_at' | 'open'
type SortDir = 'asc' | 'desc'
type StatusFilter = 'all' | GroupStatus

const SORT_COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Group' },
  { key: 'open', label: 'Slots' },
  { key: 'created_at', label: 'Created' },
  { key: 'expires_at', label: 'Expires' },
]

// ── Section ───────────────────────────────────────────────────────────────────

export function GroupRegistrationSection() {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const { data, isLoading, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteQuery(registrationGroupsInfiniteQueryOptions)

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('created_at')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const deactivateMutation = useMutation({
    mutationFn: deactivateRegistrationGroup,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'registration-groups'] })
      notify('success', 'Registration link deactivated')
    },
    onError: (err) => notify('error', err instanceof ApiError ? err.message : 'Failed to deactivate the link'),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteRegistrationGroup,
    onSuccess: (_data, id) => {
      if (expandedId === id) setExpandedId(null)
      queryClient.invalidateQueries({ queryKey: ['admin', 'registration-groups'] })
      notify('success', 'Registration group deleted')
    },
    onError: (err) => notify('error', err instanceof ApiError ? err.message : 'Failed to delete the group'),
  })

  const handleCopy = useCallback((id: string, url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000)
    })
  }, [])

  const groups = useMemo(() => data?.pages.flatMap(p => p.items ?? []) ?? [], [data])

  const visibleGroups = useMemo(() => {
    const filtered = statusFilter === 'all' ? groups : groups.filter(g => groupStatus(g) === statusFilter)
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'name':
          return dir * a.name.localeCompare(b.name)
        case 'open': {
          const openA = a.slots_total - a.slots_consumed
          const openB = b.slots_total - b.slots_consumed
          return dir * (openA - openB)
        }
        case 'expires_at': {
          // Groups without an expiry sort last regardless of direction.
          if (!a.expires_at && !b.expires_at) return 0
          if (!a.expires_at) return 1
          if (!b.expires_at) return -1
          return dir * (new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime())
        }
        default:
          return dir * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      }
    })
  }, [groups, statusFilter, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'name' ? 'asc' : 'desc')
    }
  }

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (error) return <p className="text-sm text-red-500">Failed to load registration groups.</p>

  return (
    <div>
      {/* Control bar: status filter + create */}
      <div className="mb-4 flex items-center gap-2 flex-wrap">
        <span className="text-xs text-gray-500">Status:</span>
        {(['all', 'active', 'inactive', 'expired'] as StatusFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setStatusFilter(f)}
            className={`px-2.5 py-1 text-xs rounded-md border cursor-pointer transition-colors capitalize ${
              statusFilter === f
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
            }`}
          >
            {f}
          </button>
        ))}
        <Link
          to="/admin/group-registration/create"
          className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg no-underline transition-colors"
        >
          <MdAdd /> Create group
        </Link>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full min-w-200 text-sm border-collapse">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {SORT_COLUMNS.slice(0, 1).map(({ key, label }) => (
                <SortableHeader key={key} label={label} active={sortKey === key} dir={sortDir} onClick={() => toggleSort(key)} />
              ))}
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Link</th>
              {SORT_COLUMNS.slice(1).map(({ key, label }) => (
                <SortableHeader key={key} label={label} active={sortKey === key} dir={sortDir} onClick={() => toggleSort(key)} />
              ))}
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visibleGroups.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400">
                  No registration groups{statusFilter !== 'all' ? ` (${statusFilter})` : ''} yet.
                </td>
              </tr>
            )}
            {visibleGroups.map((g) => {
              const status = groupStatus(g)
              const open = g.slots_total - g.slots_consumed
              const expanded = expandedId === g.id
              return (
                <GroupRow
                  key={g.id}
                  group={g}
                  status={status}
                  open={open}
                  expanded={expanded}
                  copied={copiedId === g.id}
                  onCopy={() => handleCopy(g.id, g.group_invite_url)}
                  onToggleDetails={() => setExpandedId(expanded ? null : g.id)}
                  onDeactivate={() => {
                    if (confirm(`Deactivate the registration link for “${g.name}”? Unclaimed slots will stop reserving capacity.`)) {
                      deactivateMutation.mutate(g.id)
                    }
                  }}
                  onDelete={() => {
                    if (confirm(`Delete the registration group “${g.name}”? This cannot be undone. Accounts already registered are unaffected.`)) {
                      deleteMutation.mutate(g.id)
                    }
                  }}
                />
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

function SortableHeader({ label, active, dir, onClick }: {
  label: string
  active: boolean
  dir: SortDir
  onClick: () => void
}) {
  return (
    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-0.5 bg-transparent border-0 p-0 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-800"
      >
        {label}
        {active
          ? (dir === 'asc' ? <MdKeyboardArrowUp className="text-sm" /> : <MdKeyboardArrowDown className="text-sm" />)
          : <MdUnfoldMore className="text-sm opacity-40" />}
      </button>
    </th>
  )
}

function GroupRow({ group: g, status, open, expanded, copied, onCopy, onToggleDetails, onDeactivate, onDelete }: {
  group: RegistrationGroupSummary
  status: GroupStatus
  open: number
  expanded: boolean
  copied: boolean
  onCopy: () => void
  onToggleDetails: () => void
  onDeactivate: () => void
  onDelete: () => void
}) {
  return (
    <>
      <tr className={`transition-colors ${expanded ? 'bg-blue-50/40' : 'hover:bg-gray-50'}`}>
        <td className="px-4 py-3 text-gray-800 font-medium">{g.name}</td>
        <td className="px-4 py-3">
          <button
            onClick={onCopy}
            title="Copy registration link"
            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 cursor-pointer bg-transparent border border-gray-200 hover:border-gray-400 rounded px-2 py-1 transition-colors max-w-56"
          >
            {copied
              ? <><MdCheck className="text-green-500 shrink-0" /> Copied</>
              : <><MdContentCopy className="shrink-0" /> <span className="truncate">{g.link_id}</span></>
            }
          </button>
        </td>
        <td className="px-4 py-3 text-gray-600 text-xs whitespace-nowrap">
          <span className="font-medium text-gray-800">{open}</span> open
          <span className="text-gray-400"> / </span>
          <span className="font-medium text-gray-800">{g.slots_consumed}</span> taken
          {g.slots_reserved > 0 && (
            <span className="ml-1.5 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
              {g.slots_reserved} in progress
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
          {new Date(g.created_at).toLocaleDateString()}
        </td>
        <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
          {g.expires_at ? new Date(g.expires_at).toLocaleDateString() : '—'}
        </td>
        <td className="px-4 py-3">
          <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full capitalize ${
            status === 'active'   ? 'bg-green-100 text-green-700' :
            status === 'expired'  ? 'bg-red-50 text-red-500' :
                                    'bg-gray-100 text-gray-500'
          }`}>
            {status}
          </span>
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2 justify-end">
            <Link
              to="/admin/group-registration/create"
              search={{ groupId: g.id }}
              className="text-xs text-gray-600 hover:text-gray-900 cursor-pointer bg-transparent border border-gray-200 hover:border-gray-400 rounded px-2 py-1 no-underline transition-colors"
            >
              Edit
            </Link>
            {status === 'active' && (
              <button
                onClick={onDeactivate}
                className="text-xs text-amber-600 hover:text-amber-800 cursor-pointer bg-transparent border border-amber-200 hover:border-amber-400 rounded px-2 py-1 transition-colors"
              >
                Deactivate
              </button>
            )}
            <button
              onClick={onDelete}
              className="text-xs text-red-500 hover:text-red-700 cursor-pointer bg-transparent border border-red-200 hover:border-red-400 rounded px-2 py-1 transition-colors"
            >
              Delete
            </button>
            <button
              onClick={onToggleDetails}
              className="inline-flex items-center gap-0.5 text-xs text-blue-600 hover:text-blue-800 cursor-pointer bg-transparent border border-blue-200 hover:border-blue-400 rounded px-2 py-1 transition-colors"
            >
              Details {expanded ? <MdKeyboardArrowUp /> : <MdKeyboardArrowDown />}
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-blue-50/40">
          <td colSpan={7} className="px-4 pb-4 pt-0">
            <GroupSlotDetails groupId={g.id} />
          </td>
        </tr>
      )}
    </>
  )
}

// ── Inline slot details ───────────────────────────────────────────────────────

function GroupSlotDetails({ groupId }: { groupId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'registration-groups', groupId],
    queryFn: () => getRegistrationGroup(groupId),
  })

  if (isLoading) return <p className="text-xs text-gray-500 m-0 py-2">Loading slots…</p>
  if (error || !data) return <p className="text-xs text-red-500 m-0 py-2">Failed to load slot details.</p>

  return (
    <div className="rounded-lg border border-blue-100 bg-white overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200">
            {['Server', 'Tier', 'Capacity', 'Account status', 'Slots', 'Status'].map((h) => (
              <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {data.slot_types.map((t) => (
            <SlotTypeRow key={t.slot_id} type={t} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SlotTypeRow({ type: t }: { type: RegistrationSlotType }) {
  return (
    <tr>
      <td className="px-3 py-2 text-gray-800">{t.server_name}</td>
      <td className="px-3 py-2">
        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${
          t.drive_type === 'nvme' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
        }`}>
          {tierLabel(t.drive_type)}
        </span>
      </td>
      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{formatSlotQuota(t.quota_bytes)}</td>
      <td className="px-3 py-2 text-gray-600">
        {t.account_status === 'premium' ? (
          <span className="inline-flex items-center gap-1">
            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700">Premium</span>
            {t.premium_expires_at && (
              <span className="text-gray-400">expires {new Date(t.premium_expires_at).toLocaleDateString()}</span>
            )}
          </span>
        ) : (
          <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-600">Base user</span>
        )}
      </td>
      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
        {t.total > 1 ? `${t.total}x` : '1'}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        {t.available > 0 && (
          <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 mr-1">
            {t.available} available
          </span>
        )}
        {t.reserved > 0 && (
          <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 mr-1">
            {t.reserved} in progress
          </span>
        )}
        {t.consumed > 0 && (
          <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
            {t.consumed} consumed
          </span>
        )}
      </td>
    </tr>
  )
}
