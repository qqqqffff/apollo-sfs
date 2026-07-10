import { createFileRoute } from '@tanstack/react-router'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { MdBlock, MdLockClock, MdLockOpen, MdPublic } from 'react-icons/md'
import {
  listBannedIPs,
  unbanIP,
  extendBan,
  listUserBans,
  pardonUser,
} from '../../api/admin'
import { useNotification } from '../../context/NotificationContext'
import type { BanType, BannedIP, UserBan } from '../../types/api'
import { VIOLATION_CODES } from '../../types/api'

type Tab = 'suspensions' | 'bans' | 'ips'

export const Route = createFileRoute('/_auth/admin/bans')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } => {
    const tab = search.tab === 'suspensions' || search.tab === 'bans' || search.tab === 'ips'
      ? search.tab : undefined
    return { tab }
  },
  component: RouteComponent,
})

type StatusFilter = 'active' | 'all'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

// ── Main component ────────────────────────────────────────────────────────────

function RouteComponent() {
  const { tab } = Route.useSearch()
  const [activeTab, setActiveTab] = useState<Tab>(tab ?? 'suspensions')

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-6 mt-0">Bans &amp; Suspensions</h2>

      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {([
          { key: 'suspensions', label: 'Suspensions' },
          { key: 'bans',        label: 'Bans' },
          { key: 'ips',         label: 'Banned IPs' },
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

      {activeTab === 'suspensions' && <UserBansTab banType="suspended" />}
      {activeTab === 'bans' && <UserBansTab banType="banned" />}
      {activeTab === 'ips' && <IPsTab />}
    </div>
  )
}

// ── Filter tabs ───────────────────────────────────────────────────────────────

function FilterTabs({ value, onChange }: { value: StatusFilter; onChange: (v: StatusFilter) => void }) {
  return (
    <div className="flex gap-1">
      {(['active', 'all'] as StatusFilter[]).map((s) => (
        <button
          key={s}
          onClick={() => onChange(s)}
          className={`px-3 py-1.5 text-xs rounded-md border cursor-pointer transition-colors capitalize ${
            value === s
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
          }`}
        >
          {s}
        </button>
      ))}
    </div>
  )
}

// ── Suspensions / Bans tab ───────────────────────────────────────────────────────

function UserBansTab({ banType }: { banType: BanType }) {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const [status, setStatus] = useState<StatusFilter>('active')

  const {
    data,
    isLoading,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    // Same queryKey shape as before (no type filter server-side) so switching
    // between the Suspensions/Bans tabs at the same status reuses the cache
    // instead of double-fetching — filtering by ban_type happens client-side.
    queryKey: ['admin', 'bans', status],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      listUserBans(status, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_token || undefined,
  })

  const pardonMutation = useMutation({
    mutationFn: pardonUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'bans'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      notify('success', 'User pardoned')
    },
    onError: () => notify('error', 'Failed to pardon user'),
  })

  const bans = (data?.pages.flatMap((p) => p.items) ?? []).filter((b) => b.ban_type === banType)
  const label = banType === 'banned' ? 'bans' : 'suspensions'

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {bans.length > 0 && (
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              banType === 'banned' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
            }`}>
              {bans.length}{hasNextPage ? '+' : ''}
            </span>
          )}
        </div>
        <FilterTabs value={status} onChange={setStatus} />
      </div>

      {isLoading && <p className="text-sm text-gray-400">Loading…</p>}

      {!isLoading && bans.length === 0 && (
        <div className="flex flex-col items-center py-10 gap-2 text-gray-400">
          <MdBlock className="text-4xl" />
          <p className="text-sm m-0">
            {status === 'active' ? `No active ${label}.` : `No ${label} records found.`}
          </p>
        </div>
      )}

      {bans.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table className="w-full min-w-175 text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['User', 'Violation', 'Comments', `${banType === 'banned' ? 'Banned' : 'Suspended'} by`, `${banType === 'banned' ? 'Banned' : 'Suspended'} at`, 'Expires', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {bans.map((ban) => (
                <UserBanRow
                  key={ban.id}
                  ban={ban}
                  onPardon={() => {
                    if (confirm(`Pardon ${ban.username}?`)) pardonMutation.mutate(ban.username)
                  }}
                  pendingPardon={pardonMutation.isPending && pardonMutation.variables === ban.username}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

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

// ── Banned IPs tab ────────────────────────────────────────────────────────────

function IPsTab() {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const [status, setStatus] = useState<StatusFilter>('active')

  const {
    data,
    isLoading,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: ['admin', 'banned-ips', status],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      listBannedIPs(status, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_token || undefined,
  })

  const unbanMutation = useMutation({
    mutationFn: unbanIP,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'banned-ips'] })
      notify('success', 'IP marked as unbanned')
    },
    onError: () => notify('error', 'Failed to unban IP'),
  })

  const extendMutation = useMutation({
    mutationFn: extendBan,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'banned-ips'] })
      notify('success', 'Ban extended')
    },
    onError: () => notify('error', 'Failed to extend ban'),
  })

  const ips = data?.pages.flatMap((p) => p.items) ?? []

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {ips.length > 0 && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
              {ips.length}{hasNextPage ? '+' : ''}
            </span>
          )}
        </div>
        <FilterTabs value={status} onChange={setStatus} />
      </div>

      {isLoading && <p className="text-sm text-gray-400">Loading…</p>}

      {!isLoading && ips.length === 0 && (
        <div className="flex flex-col items-center py-10 gap-2 text-gray-400">
          <MdBlock className="text-4xl" />
          <p className="text-sm m-0">
            {status === 'active' ? 'No active IP bans.' : 'No IP ban records found.'}
          </p>
        </div>
      )}

      {ips.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table className="w-full min-w-180 text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['IP Address', 'Location', 'Banned At', 'Bans', 'Jail', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {ips.map((ban) => (
                <IPBanRow
                  key={ban.id}
                  ban={ban}
                  onUnban={() => {
                    if (confirm(`Remove ban for ${ban.ip}?\n\nNote: the nginx deny rule will remain until fail2ban's timer expires or you run:\nfail2ban-client set nginx-api-scan unbanip ${ban.ip}`)) {
                      unbanMutation.mutate(ban.id)
                    }
                  }}
                  onExtend={() => extendMutation.mutate(ban.id)}
                  pendingUnban={unbanMutation.isPending && unbanMutation.variables === ban.id}
                  pendingExtend={extendMutation.isPending && extendMutation.variables === ban.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

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

// ── User ban row ──────────────────────────────────────────────────────────────

function UserBanRow({ ban, onPardon, pendingPardon }: {
  ban: UserBan
  onPardon: () => void
  pendingPardon: boolean
}) {
  const isActive = ban.pardoned_at === null

  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-4 py-3 font-medium text-gray-900">{ban.username}</td>
      <td className="px-4 py-3 text-gray-600 text-xs max-w-40">
        <span title={ban.violation_code}>
          {VIOLATION_CODES[ban.violation_code] ?? ban.violation_code}
        </span>
      </td>
      <td className="px-4 py-3 text-gray-500 text-xs max-w-48">
        {ban.comments || <span className="text-gray-300">—</span>}
      </td>
      <td className="px-4 py-3 text-gray-400 text-xs">{ban.banned_by}</td>
      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
        <span title={new Date(ban.banned_at).toLocaleString()}>
          {formatRelative(ban.banned_at)}
        </span>
      </td>
      <td className="px-4 py-3 text-xs whitespace-nowrap">
        {ban.expires_at ? (
          <span className="text-gray-500" title={new Date(ban.expires_at).toLocaleString()}>
            {new Date(ban.expires_at) > new Date()
              ? new Date(ban.expires_at).toLocaleString()
              : <span className="text-gray-300">Expired</span>
            }
          </span>
        ) : (
          <span className="text-red-500 font-medium">Permanent</span>
        )}
        {ban.pardoned_at && (
          <div className="text-gray-400 mt-0.5">
            pardoned {formatRelative(ban.pardoned_at)}
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        {isActive ? (
          <button
            onClick={onPardon}
            disabled={pendingPardon}
            title="Pardon user"
            className="inline-flex items-center gap-1 text-xs text-green-600 hover:text-green-800 cursor-pointer bg-transparent border border-green-200 hover:border-green-400 rounded px-2 py-1 transition-colors disabled:opacity-40"
          >
            <MdLockOpen className="text-sm" />
            {pendingPardon ? 'Pardoning…' : 'Pardon'}
          </button>
        ) : (
          <span className="text-xs text-gray-400">Pardoned</span>
        )}
      </td>
    </tr>
  )
}

// ── IP ban row ────────────────────────────────────────────────────────────────

function IPBanRow({ ban, onUnban, onExtend, pendingUnban, pendingExtend }: {
  ban: BannedIP
  onUnban: () => void
  onExtend: () => void
  pendingUnban: boolean
  pendingExtend: boolean
}) {
  const isActive = ban.unbanned_at === null
  const hasGeo = ban.country || ban.city

  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-4 py-3 font-mono text-sm font-medium text-gray-900">{ban.ip}</td>
      <td className="px-4 py-3 text-gray-600">
        {hasGeo ? (
          <span className="flex items-center gap-1.5">
            <MdPublic className="text-gray-400 shrink-0" />
            {[ban.city, ban.country].filter(Boolean).join(', ')}
          </span>
        ) : (
          <span className="text-gray-400 text-xs">Unknown</span>
        )}
      </td>
      <td className="px-4 py-3 text-gray-500 text-xs">
        <div title={new Date(ban.banned_at).toLocaleString()}>
          {formatRelative(ban.banned_at)}
        </div>
        {!isActive && ban.unbanned_at && (
          <div className="text-gray-400 mt-0.5">unbanned {formatRelative(ban.unbanned_at)}</div>
        )}
      </td>
      <td className="px-4 py-3">
        <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full ${
          ban.ban_count >= 3 ? 'bg-red-100 text-red-700'
            : ban.ban_count >= 2 ? 'bg-amber-100 text-amber-700'
            : 'bg-gray-100 text-gray-600'
        }`}>
          {ban.ban_count}×
        </span>
      </td>
      <td className="px-4 py-3 text-gray-400 text-xs font-mono">{ban.jail}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {isActive ? (
            <>
              <button
                onClick={onExtend}
                disabled={pendingExtend}
                title="Reset ban timer (+7 days in DB)"
                className="inline-flex items-center gap-1 text-xs text-amber-600 hover:text-amber-800 cursor-pointer bg-transparent border border-amber-200 hover:border-amber-400 rounded px-2 py-1 transition-colors disabled:opacity-40"
              >
                <MdLockClock className="text-sm" />
                {pendingExtend ? 'Extending…' : 'Extend'}
              </button>
              <button
                onClick={onUnban}
                disabled={pendingUnban}
                title="Mark as unbanned"
                className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700 cursor-pointer bg-transparent border border-red-200 hover:border-red-400 rounded px-2 py-1 transition-colors disabled:opacity-40"
              >
                <MdBlock className="text-sm" />
                {pendingUnban ? 'Unbanning…' : 'Unban'}
              </button>
            </>
          ) : (
            <span className="text-xs text-gray-400">Unbanned</span>
          )}
        </div>
      </td>
    </tr>
  )
}
