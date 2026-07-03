import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ALARM_DEFAULT_THRESHOLD,
  ALARM_SCOPE,
  ALARM_UNIT,
  adminUsersInfiniteQueryOptions,
  deleteAlarmSubscription,
  getAlarmSubscriptions,
  infrastructureQueryOptions,
  upsertAlarmSubscription,
} from '../../api/admin'
import type { AlarmSubscription, AlarmType } from '../../api/admin'
import type { PageResult, User } from '../../types/api'
import { AlarmConfig } from '../../components/AlarmConfig'
import { useNotification } from '../../context/NotificationContext'

export const Route = createFileRoute('/_auth/admin/alarm')({
  component: RouteComponent,
})

const ALARM_LABELS: Record<AlarmType, string> = {
  cpu_usage: 'High CPU usage',
  cpu_temp: 'High CPU temperature',
  memory: 'High memory usage',
  network_traffic: 'High network traffic',
  drive_temp: 'High drive temperature',
  drive_load: 'High drive load',
  api_error_rate: 'Elevated API error rate',
}

const ALARM_TYPES = Object.keys(ALARM_LABELS) as AlarmType[]

function subTargetLabel(s: AlarmSubscription): string {
  if (s.node_id) return `${s.node_hostname ?? 'node'}${s.node_role ? ` · ${s.node_role}` : ''}`
  if (s.drive_id) return `${s.drive_label ?? 'drive'}${s.server_name ? ` · ${s.server_name}` : ''}`
  return 'Cluster'
}

function RouteComponent() {
  const queryClient = useQueryClient()
  const { notify } = useNotification()

  const [selectedUser, setSelectedUser] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const { data, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteQuery(adminUsersInfiniteQueryOptions)
  const users = useMemo(
    () => (data?.pages as PageResult<User>[] | undefined)?.flatMap(p => p.items) ?? [],
    [data],
  )
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return users
    return users.filter(u => u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
  }, [users, search])

  const subsKey = ['admin', 'alarm', 'subscriptions', selectedUser] as const
  const { data: subs, isLoading: subsLoading } = useQuery({
    queryKey: subsKey,
    queryFn: () => getAlarmSubscriptions(selectedUser!),
    enabled: !!selectedUser,
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: subsKey })
  const upsertMut = useMutation({
    mutationFn: upsertAlarmSubscription,
    onSuccess: invalidate,
    onError: () => notify('error', 'Failed to save alarm'),
  })
  const removeMut = useMutation({
    mutationFn: deleteAlarmSubscription,
    onSuccess: invalidate,
    onError: () => notify('error', 'Failed to remove alarm'),
  })
  const pending = upsertMut.isPending || removeMut.isPending

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Alarm Configuration</h1>
        <p className="mt-1 text-sm text-gray-500">
          Review and edit which alarms a user is subscribed to. Per-node and per-drive
          alarms are otherwise managed by each admin from the Metrics page.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-6">
        {/* User picker */}
        <section className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search users…"
              className="w-full text-sm border border-gray-200 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <ul className="max-h-[28rem] overflow-y-auto divide-y divide-gray-50">
            {filtered.map(u => (
              <li key={u.username}>
                <button
                  onClick={() => setSelectedUser(u.username)}
                  className={`w-full text-left px-4 py-2 cursor-pointer transition-colors ${
                    selectedUser === u.username ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <div className="text-sm font-medium text-gray-800 truncate">{u.username}</div>
                  <div className="text-xs text-gray-400 truncate">{u.email}</div>
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="px-4 py-3 text-xs text-gray-400">No users match.</li>
            )}
          </ul>
          {hasNextPage && (
            <button
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="w-full text-xs text-blue-600 hover:text-blue-700 cursor-pointer bg-transparent border-0 py-2 disabled:opacity-50"
            >
              {isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </section>

        {/* Subscriptions for the selected user */}
        <section>
          {!selectedUser ? (
            <p className="text-sm text-gray-400">Select a user to review their alarms.</p>
          ) : (
            <div className="space-y-5">
              <AddAlarmForm
                username={selectedUser}
                existing={subs ?? []}
                onAdd={(body) => upsertMut.mutate({ ...body, username: selectedUser })}
                pending={pending}
              />

              <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
                <h2 className="text-sm font-semibold text-gray-900 px-5 pt-5 pb-3">
                  Subscriptions for {selectedUser}
                </h2>
                {subsLoading && <p className="px-5 py-4 text-sm text-gray-400 m-0">Loading…</p>}
                {!subsLoading && (subs?.length ?? 0) === 0 && (
                  <p className="px-5 py-4 text-sm text-gray-400 m-0">No alarms configured for this user.</p>
                )}
                {subs?.map(s => (
                  <AlarmConfig
                    key={s.id}
                    alarmType={s.alarm_type}
                    label={ALARM_LABELS[s.alarm_type]}
                    targetLabel={subTargetLabel(s)}
                    subscription={s}
                    pending={pending}
                    onUpsert={(threshold) => upsertMut.mutate({
                      alarm_type: s.alarm_type,
                      node_id: s.node_id ?? undefined,
                      drive_id: s.drive_id ?? undefined,
                      threshold,
                      username: selectedUser,
                    })}
                    onRemove={() => removeMut.mutate({
                      alarm_type: s.alarm_type,
                      node_id: s.node_id ?? undefined,
                      drive_id: s.drive_id ?? undefined,
                      username: selectedUser,
                    })}
                  />
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

interface AddAlarmBody {
  alarm_type: AlarmType
  node_id?: string
  drive_id?: string
  threshold: number
}

// AddAlarmForm lets an admin create a new subscription for the selected user:
// pick an alarm type, then a target (node / drive / none for cluster) and a
// threshold. Targets come from the live infrastructure index.
function AddAlarmForm({ username, existing, onAdd, pending }: {
  username: string
  existing: AlarmSubscription[]
  onAdd: (body: AddAlarmBody) => void
  pending: boolean
}) {
  const { data: infra } = useQuery(infrastructureQueryOptions)
  const nodes = infra?.nodes ?? []
  const drives = infra?.drives ?? []

  const [alarmType, setAlarmType] = useState<AlarmType>('cpu_usage')
  const [targetId, setTargetId] = useState<string>('')
  const [threshold, setThreshold] = useState<string>(String(ALARM_DEFAULT_THRESHOLD['cpu_usage']))

  const scope = ALARM_SCOPE[alarmType]

  function changeType(t: AlarmType) {
    setAlarmType(t)
    setTargetId('')
    setThreshold(String(ALARM_DEFAULT_THRESHOLD[t]))
  }

  // Prevent duplicate (type + target) rows the backend would just overwrite.
  const duplicate = existing.some(s =>
    s.alarm_type === alarmType &&
    (s.node_id ?? '') === (scope === 'node' ? targetId : '') &&
    (s.drive_id ?? '') === (scope === 'drive' ? targetId : ''),
  )
  const targetMissing = scope !== 'cluster' && !targetId
  const thr = Number(threshold)
  const canAdd = !pending && !duplicate && !targetMissing && Number.isFinite(thr) && thr > 0

  function submit() {
    if (!canAdd) return
    onAdd({
      alarm_type: alarmType,
      node_id: scope === 'node' ? targetId : undefined,
      drive_id: scope === 'drive' ? targetId : undefined,
      threshold: thr,
    })
    setTargetId('')
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
      <h2 className="text-sm font-semibold text-gray-900 mb-3">Add alarm for {username}</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-400">Alarm</span>
          <select
            value={alarmType}
            onChange={(e) => changeType(e.target.value as AlarmType)}
            className="text-sm border border-gray-200 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {ALARM_TYPES.map(t => <option key={t} value={t}>{ALARM_LABELS[t]}</option>)}
          </select>
        </label>

        {scope === 'node' && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Node</span>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="text-sm border border-gray-200 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select node…</option>
              {nodes.map(n => (
                <option key={n.node_id} value={n.node_id}>{n.hostname} · {n.role}</option>
              ))}
            </select>
          </label>
        )}

        {scope === 'drive' && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Drive</span>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="text-sm border border-gray-200 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select drive…</option>
              {drives.map(d => (
                <option key={d.drive_id} value={d.drive_id}>{d.drive_label} · {d.server_name}</option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-400">Threshold</span>
          <div className="flex items-center gap-1">
            <input
              type="number"
              inputMode="decimal"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              className="w-20 text-right text-sm border border-gray-200 rounded-md px-2 py-1.5 tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-xs text-gray-400 whitespace-nowrap">{ALARM_UNIT[alarmType]}</span>
          </div>
        </label>

        <button
          onClick={submit}
          disabled={!canAdd}
          className="text-sm bg-blue-600 text-white rounded-md px-3 py-1.5 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
        >
          Add
        </button>
      </div>
      {duplicate && (
        <p className="text-xs text-amber-600 mt-2">This user already has that alarm on the selected target.</p>
      )}
    </div>
  )
}
