import { createFileRoute } from '@tanstack/react-router'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { MdBlock, MdLockClock, MdPublic } from 'react-icons/md'
import { listBannedIPs, unbanIP, extendBan } from '../../api/admin'
import { useNotification } from '../../context/NotificationContext'
import type { BannedIP } from '../../types/api'

export const Route = createFileRoute('/_auth/admin/banned-ips')({
  component: RouteComponent,
})

type StatusFilter = 'active' | 'all'

function RouteComponent() {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const [status, setStatus] = useState<StatusFilter>('active')

  const { data, isLoading, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteQuery({
      queryKey: ['admin', 'banned-ips', status],
      queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
        listBannedIPs(status, pageParam),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.next_token || undefined,
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

  const bans = data?.pages.flatMap((p) => p.items) ?? []
  const totalShown = bans.length

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (error) return <p className="text-sm text-red-500">Failed to load banned IPs.</p>

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-900 m-0">Banned IPs</h2>
          {totalShown > 0 && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700">
              {totalShown}{hasNextPage ? '+' : ''} shown
            </span>
          )}
        </div>
        <div className="flex gap-1">
          {(['active', 'all'] as StatusFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-3 py-1.5 text-xs rounded-md border cursor-pointer transition-colors capitalize ${
                status === s
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {bans.length === 0 ? (
        <div className="flex flex-col items-center py-16 gap-3 text-gray-400">
          <MdBlock className="text-5xl" />
          <p className="text-sm m-0">
            {status === 'active' ? 'No active bans.' : 'No ban records found.'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['IP Address', 'Location', 'Banned At', 'Bans', 'Jail', ''].map((h) => (
                  <th
                    key={h}
                    className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {bans.map((ban) => (
                <BanRow
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

// ── Row ───────────────────────────────────────────────────────────────────────

interface BanRowProps {
  ban: BannedIP
  onUnban: () => void
  onExtend: () => void
  pendingUnban: boolean
  pendingExtend: boolean
}

function BanRow({ ban, onUnban, onExtend, pendingUnban, pendingExtend }: BanRowProps) {
  const isActive = ban.unbanned_at === null
  const hasGeo = ban.country || ban.city

  return (
    <tr className="hover:bg-gray-50 transition-colors">
      {/* IP */}
      <td className="px-4 py-3 font-mono text-sm font-medium text-gray-900">
        {ban.ip}
      </td>

      {/* Location */}
      <td className="px-4 py-3 text-gray-600">
        {hasGeo ? (
          <span className="flex items-center gap-1.5">
            <MdPublic className="text-gray-400 shrink-0" />
            <span>
              {[ban.city, ban.country].filter(Boolean).join(', ')}
            </span>
          </span>
        ) : (
          <span className="text-gray-400 text-xs">Unknown</span>
        )}
      </td>

      {/* Banned At */}
      <td className="px-4 py-3 text-gray-500 text-xs">
        <div title={new Date(ban.banned_at).toLocaleString()}>
          {formatRelative(ban.banned_at)}
        </div>
        {!isActive && ban.unbanned_at && (
          <div className="text-gray-400 mt-0.5">
            unbanned {formatRelative(ban.unbanned_at)}
          </div>
        )}
      </td>

      {/* Ban count */}
      <td className="px-4 py-3">
        <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full ${
          ban.ban_count >= 3
            ? 'bg-red-100 text-red-700'
            : ban.ban_count >= 2
              ? 'bg-amber-100 text-amber-700'
              : 'bg-gray-100 text-gray-600'
        }`}>
          {ban.ban_count}×
        </span>
      </td>

      {/* Jail */}
      <td className="px-4 py-3 text-gray-400 text-xs font-mono">{ban.jail}</td>

      {/* Actions */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {isActive ? (
            <>
              <button
                onClick={onExtend}
                disabled={pendingExtend}
                title="Reset ban timer (+7 days in DB)"
                className="inline-flex items-center gap-1 text-xs text-amber-600 hover:text-amber-800 cursor-pointer bg-transparent border border-amber-200 hover:border-amber-400 rounded px-2 py-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <MdLockClock className="text-sm" />
                {pendingExtend ? 'Extending…' : 'Extend'}
              </button>
              <button
                onClick={onUnban}
                disabled={pendingUnban}
                title="Mark as unbanned in database"
                className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700 cursor-pointer bg-transparent border border-red-200 hover:border-red-400 rounded px-2 py-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}
