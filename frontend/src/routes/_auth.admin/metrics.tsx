import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  addDrive,
  createServer,
  getMetricsHistoryByHours,
  infrastructureQueryOptions,
  updateDrive,
  updateServer,
} from '../../api/admin'
import type { DriveSummary } from '../../api/admin'
import { useMetricsStream } from '../../hooks/useMetricsStream'
import { BarGraph } from '../../components/BarGraph'
import { LineGraph } from '../../components/LineGraph'
import type { LinePoint } from '../../components/LineGraph'
import { useNotification } from '../../context/NotificationContext'

export const Route = createFileRoute('/_auth/admin/metrics')({
  component: RouteComponent,
})

const GB = 1024 ** 3

type HourWindow = 1 | 12 | 24 | 48 | 72
const HOUR_OPTIONS: HourWindow[] = [1, 12, 24, 48, 72]

function formatTempY(v: number): string {
  return `${v.toFixed(1)}°C`
}

function RouteComponent() {
  const { notify } = useNotification()
  const queryClient = useQueryClient()
  const { snapshots, connected } = useMetricsStream()
  const [hours, setHours] = useState<HourWindow>(12)

  const { data: infraData } = useQuery(infrastructureQueryOptions)
  const drives = infraData?.drives ?? []

  // Group drives by server
  const serverMap = new Map<string, { name: string; serverId: string; isActive: boolean; drives: DriveSummary[] }>()
  for (const d of drives) {
    if (!serverMap.has(d.server_id)) {
      serverMap.set(d.server_id, {
        name: d.server_name,
        serverId: d.server_id,
        isActive: d.server_is_active,
        drives: [],
      })
    }
    serverMap.get(d.server_id)!.drives.push(d)
  }
  const servers = Array.from(serverMap.values())

  const toggleServerMutation = useMutation({
    mutationFn: ({ serverId, active }: { serverId: string; active: boolean }) =>
      updateServer(serverId, { is_active: active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'infrastructure'] }),
    onError: () => notify('error', 'Failed to update server'),
  })

  const toggleDriveMutation = useMutation({
    mutationFn: ({ serverId, driveId, active }: { serverId: string; driveId: string; active: boolean }) =>
      updateDrive(serverId, driveId, { is_active: active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'infrastructure'] }),
    onError: () => notify('error', 'Failed to update drive'),
  })

  const addServerMutation = useMutation({
    mutationFn: createServer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'infrastructure'] })
      notify('success', 'Server added')
    },
    onError: () => notify('error', 'Failed to add server'),
  })

  const addDriveMutation = useMutation({
    mutationFn: ({ serverId, params }: { serverId: string; params: Parameters<typeof addDrive>[1] }) =>
      addDrive(serverId, params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'infrastructure'] })
      notify('success', 'Drive added')
    },
    onError: () => notify('error', 'Failed to add drive'),
  })

  const latest = snapshots[snapshots.length - 1]

  const cpuPct = latest?.cpu_percent ?? 0
  const memPct =
    latest && latest.memory_total_bytes > 0
      ? (latest.memory_used_bytes / latest.memory_total_bytes) * 100
      : 0

  // Committed disk = physically used + quota reserved but not yet uploaded
  const diskUsedBytes = latest ? latest.disk_total_bytes - latest.disk_free_bytes : 0
  const quotaOverheadBytes = latest
    ? Math.max(0, latest.storage_total_quota_bytes - latest.storage_total_used_bytes)
    : 0
  const diskCommittedBytes = diskUsedBytes + quotaOverheadBytes
  const diskCommittedPct =
    latest && latest.disk_total_bytes > 0
      ? (diskCommittedBytes / latest.disk_total_bytes) * 100
      : 0

  const bars = [
    { label: 'CPU',    value: cpuPct,          color: '#f59e0b' },
    { label: 'Memory', value: memPct,           color: '#8b5cf6',
      detail: latest
        ? `${(latest.memory_used_bytes / GB).toFixed(1)} / ${(latest.memory_total_bytes / GB).toFixed(1)} GB`
        : undefined },
    { label: 'Disk',   value: diskCommittedPct, color: '#3b82f6',
      detail: latest
        ? `${(diskUsedBytes / GB).toFixed(1)} used · ${(quotaOverheadBytes / GB).toFixed(1)} reserved / ${(latest.disk_total_bytes / GB).toFixed(0)} GB`
        : undefined },
  ]

  const nowMs = Date.now()

  // Storage line points
  const wsStoragePoints: LinePoint[] = snapshots
    .filter(s => new Date(s.sampled_at).getTime() >= nowMs - 60 * 60 * 1000)
    .map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.storage_total_used_bytes }))

  // Temperature line points (live)
  const wsCpuTempPoints: LinePoint[] = snapshots
    .filter(s => s.cpu_temp_celsius != null && new Date(s.sampled_at).getTime() >= nowMs - 60 * 60 * 1000)
    .map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.cpu_temp_celsius! }))

  const wsDriveTempPoints: LinePoint[] = snapshots
    .filter(s => s.drive_temp_celsius != null && new Date(s.sampled_at).getTime() >= nowMs - 60 * 60 * 1000)
    .map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.drive_temp_celsius! }))

  const { data: historySnaps, error: historyError } = useQuery({
    queryKey: ['admin', 'metrics', 'history', hours],
    queryFn: () => getMetricsHistoryByHours(hours),
    staleTime: 60_000,
    enabled: hours > 1,
    retry: 1,
  })

  useEffect(() => {
    if (historyError) notify('error', 'Failed to load metrics history')
  }, [historyError, notify])

  const historyStoragePoints: LinePoint[] = (historySnaps ?? []).map(s => ({
    x: new Date(s.sampled_at).getTime(),
    y: s.storage_total_used_bytes,
  }))

  const historyCpuTempPoints: LinePoint[] = (historySnaps ?? [])
    .filter(s => s.cpu_temp_celsius != null)
    .map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.cpu_temp_celsius! }))

  const historyDriveTempPoints: LinePoint[] = (historySnaps ?? [])
    .filter(s => s.drive_temp_celsius != null)
    .map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.drive_temp_celsius! }))

  const storagePoints = hours === 1 ? wsStoragePoints : historyStoragePoints
  const cpuTempPoints = hours === 1 ? wsCpuTempPoints : historyCpuTempPoints
  const driveTempPoints = hours === 1 ? wsDriveTempPoints : historyDriveTempPoints

  const hasCpuTemp = latest?.cpu_temp_celsius != null
  const hasDriveTemp = latest?.drive_temp_celsius != null
  const hasTemps = hasCpuTemp || hasDriveTemp

  let netSentRate: string | null = null
  let netRecvRate: string | null = null
  if (snapshots.length >= 2) {
    const prev = snapshots[snapshots.length - 2]
    const curr = snapshots[snapshots.length - 1]
    const dtMs = new Date(curr.sampled_at).getTime() - new Date(prev.sampled_at).getTime()
    if (dtMs > 0) {
      netSentRate = formatBytesPerSec(((curr.network_bytes_sent - prev.network_bytes_sent) / dtMs) * 1000)
      netRecvRate = formatBytesPerSec(((curr.network_bytes_recv - prev.network_bytes_recv) / dtMs) * 1000)
    }
  }

  const graphW = Math.min(820, window.innerWidth - 80)
  const halfGraphW = Math.floor((graphW - 16) / 2)

  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-3 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 m-0">System Metrics</h2>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
          connected ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
        }`}>
          {connected ? 'Live' : 'Reconnecting…'}
        </span>
      </div>

      {latest && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 mb-8">
          <StatCard label="Total users"    value={String(latest.total_user_count)} />
          <StatCard label="Active (5 min)" value={String(latest.active_user_count)} />
          <StatCard
            label="Disk committed"
            value={`${(diskCommittedBytes / GB).toFixed(1)} GB`}
            sub={`${diskCommittedPct.toFixed(1)}% of ${(latest.disk_total_bytes / GB).toFixed(0)} GB`}
          />
          <StatCard
            label="Memory"
            value={`${(latest.memory_used_bytes / GB).toFixed(2)} GB`}
            sub={`${memPct.toFixed(1)}% of ${(latest.memory_total_bytes / GB).toFixed(1)} GB`}
          />
          {netSentRate !== null && (
            <StatCard label="Net ↑ / ↓" value={`${netSentRate} / ${netRecvRate}`} />
          )}
          {hasCpuTemp && (
            <StatCard label="CPU temp" value={`${latest.cpu_temp_celsius!.toFixed(1)}°C`} />
          )}
          {hasDriveTemp && (
            <StatCard label="Drive temp" value={`${latest.drive_temp_celsius!.toFixed(1)}°C`} />
          )}
        </div>
      )}

      <section className="mb-10">
        <h3 className="text-sm font-semibold text-gray-600 mb-3 mt-0">Live utilisation</h3>
        <div className="bg-white border border-gray-200 rounded-xl px-6 py-4">
          {snapshots.length === 0 ? (
            <p className="text-sm text-gray-400 m-0">Waiting for first snapshot…</p>
          ) : (
            <BarGraph bars={bars} height={220} />
          )}
        </div>
      </section>

      <section className="mb-10">
        <div className="flex items-center gap-3 mb-3">
          <h3 className="text-sm font-semibold text-gray-600 m-0">Storage over time</h3>
          <div className="flex gap-1">
            {HOUR_OPTIONS.map(h => (
              <button
                key={h}
                onClick={() => setHours(h)}
                className={`px-2.5 py-1 text-xs rounded-md border cursor-pointer transition-colors ${
                  hours === h
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                }`}
              >
                {h}hr
              </button>
            ))}
          </div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl px-6 py-4">
          <LineGraph
            points={storagePoints}
            width={graphW}
            height={200}
          />
        </div>
      </section>

      {hasTemps && (
        <section className="mb-10">
          <h3 className="text-sm font-semibold text-gray-600 mb-3 mt-0">Temperature over time</h3>
          <div className={`grid gap-4 ${hasCpuTemp && hasDriveTemp ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {hasCpuTemp && (
              <div className="bg-white border border-gray-200 rounded-xl px-6 py-4">
                <div className="text-xs text-gray-400 mb-2">CPU</div>
                <LineGraph
                  points={cpuTempPoints}
                  width={hasDriveTemp ? halfGraphW : graphW}
                  height={160}
                  color="#f59e0b"
                  formatY={formatTempY}
                />
              </div>
            )}
            {hasDriveTemp && (
              <div className="bg-white border border-gray-200 rounded-xl px-6 py-4">
                <div className="text-xs text-gray-400 mb-2">Drive</div>
                <LineGraph
                  points={driveTempPoints}
                  width={hasCpuTemp ? halfGraphW : graphW}
                  height={160}
                  color="#10b981"
                  formatY={formatTempY}
                />
              </div>
            )}
          </div>
        </section>
      )}

      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-600 m-0">Infrastructure</h3>
          <AddServerForm onSubmit={(params) => addServerMutation.mutate(params)} pending={addServerMutation.isPending} />
        </div>
        {servers.length === 0 ? (
          <p className="text-sm text-gray-400">No servers registered.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {servers.map((srv) => (
              <div key={srv.serverId} className="bg-white border border-gray-200 rounded-xl px-5 py-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${srv.isActive ? 'bg-green-500' : 'bg-gray-300'}`} />
                    <span className="font-medium text-gray-800 text-sm">{srv.name}</span>
                    {!srv.isActive && <span className="text-xs text-gray-400">(inactive)</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleServerMutation.mutate({ serverId: srv.serverId, active: !srv.isActive })}
                      className="text-xs text-gray-500 hover:text-gray-800 cursor-pointer bg-transparent border border-gray-200 hover:border-gray-400 rounded px-2 py-1 transition-colors"
                    >
                      {srv.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                    <AddDriveForm
                      onSubmit={(params) => addDriveMutation.mutate({ serverId: srv.serverId, params })}
                      pending={addDriveMutation.isPending}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-3">
                  {srv.drives.map((d) => (
                    <DriveBar
                      key={d.drive_id}
                      drive={d}
                      onToggle={() => toggleDriveMutation.mutate({
                        serverId: d.server_id,
                        driveId: d.drive_id,
                        active: !d.drive_is_active,
                      })}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="text-xl font-semibold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}

function formatBytesPerSec(bps: number): string {
  if (bps < 0) bps = 0
  const KB = 1024, MB = KB * 1024
  if (bps >= MB) return `${(bps / MB).toFixed(1)} MB/s`
  if (bps >= KB) return `${(bps / KB).toFixed(1)} KB/s`
  return `${bps.toFixed(0)} B/s`
}

function DriveBar({ drive, onToggle }: { drive: DriveSummary; onToggle: () => void }) {
  const cap = drive.capacity_bytes || 1
  const allocPct = Math.min(100, (drive.allocated_quota_bytes / cap) * 100)
  const usedPct = Math.min(100, (drive.used_bytes / cap) * 100)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${drive.drive_is_active ? 'bg-green-400' : 'bg-gray-300'}`} />
          <span className="text-gray-700 font-medium">{drive.drive_label}</span>
          <span className="text-gray-400">{drive.minio_bucket}</span>
        </div>
        <div className="flex items-center gap-3 text-gray-400">
          <span>
            {(drive.used_bytes / GB).toFixed(1)} used ·{' '}
            {(drive.allocated_quota_bytes / GB).toFixed(1)} allocated /{' '}
            {(drive.capacity_bytes / GB).toFixed(0)} GB
          </span>
          <button
            onClick={onToggle}
            className="text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border border-gray-200 hover:border-gray-400 rounded px-2 py-0.5 transition-colors"
          >
            {drive.drive_is_active ? 'Deactivate' : 'Activate'}
          </button>
        </div>
      </div>
      <div className="relative h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-blue-200 rounded-full" style={{ width: `${allocPct.toFixed(1)}%` }} />
        <div className="absolute inset-y-0 left-0 bg-blue-500 rounded-full" style={{ width: `${usedPct.toFixed(1)}%` }} />
      </div>
    </div>
  )
}

function AddServerForm({ onSubmit, pending }: {
  onSubmit: (p: Parameters<typeof createServer>[0]) => void
  pending: boolean
}) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [ssl, setSsl] = useState(false)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    onSubmit({ state, minio_endpoint: endpoint, minio_use_ssl: ssl, access_key: accessKey, secret_key: secretKey })
    setOpen(false)
    setState(''); setEndpoint(''); setAccessKey(''); setSecretKey('')
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer bg-transparent border border-blue-200 hover:border-blue-400 rounded px-2 py-1 transition-colors">
        + Add server
      </button>
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap gap-2 items-center">
      <input value={state} onChange={e => setState(e.target.value.toUpperCase())} maxLength={2} placeholder="State (NH)" required className="w-20 border border-gray-200 rounded px-2 py-1 text-xs" />
      <input value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="minio:9000" required className="w-36 border border-gray-200 rounded px-2 py-1 text-xs" />
      <input value={accessKey} onChange={e => setAccessKey(e.target.value)} placeholder="Access key" required className="w-28 border border-gray-200 rounded px-2 py-1 text-xs" />
      <input value={secretKey} onChange={e => setSecretKey(e.target.value)} placeholder="Secret key" type="password" required className="w-28 border border-gray-200 rounded px-2 py-1 text-xs" />
      <label className="flex items-center gap-1 text-xs text-gray-500 cursor-pointer">
        <input type="checkbox" checked={ssl} onChange={e => setSsl(e.target.checked)} /> SSL
      </label>
      <button type="submit" disabled={pending} className="text-xs bg-blue-600 text-white rounded px-2 py-1 disabled:opacity-50 cursor-pointer">
        {pending ? 'Adding…' : 'Add'}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0">
        Cancel
      </button>
    </form>
  )
}

function AddDriveForm({ onSubmit, pending }: {
  onSubmit: (p: { label: string; minio_bucket: string; capacity_bytes: number }) => void
  pending: boolean
}) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [bucket, setBucket] = useState('')
  const [capacityGb, setCapacityGb] = useState('')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const gb = parseFloat(capacityGb)
    if (isNaN(gb) || gb <= 0) return
    onSubmit({ label, minio_bucket: bucket, capacity_bytes: Math.round(gb * GB) })
    setOpen(false)
    setLabel(''); setBucket(''); setCapacityGb('')
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-gray-500 hover:text-gray-800 cursor-pointer bg-transparent border border-gray-200 hover:border-gray-400 rounded px-2 py-1 transition-colors">
        + Add drive
      </button>
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap gap-2 items-center">
      <input value={label} onChange={e => setLabel(e.target.value)} placeholder="nvme-02" required className="w-24 border border-gray-200 rounded px-2 py-1 text-xs" />
      <input value={bucket} onChange={e => setBucket(e.target.value)} placeholder="Bucket name" required className="w-32 border border-gray-200 rounded px-2 py-1 text-xs" />
      <div className="flex items-center gap-1">
        <input value={capacityGb} onChange={e => setCapacityGb(e.target.value)} type="number" min="1" step="0.1" placeholder="TB in GB" required className="w-24 border border-gray-200 rounded px-2 py-1 text-xs" />
        <span className="text-xs text-gray-400">GB</span>
      </div>
      <button type="submit" disabled={pending} className="text-xs bg-blue-600 text-white rounded px-2 py-1 disabled:opacity-50 cursor-pointer">
        {pending ? 'Adding…' : 'Add'}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0">
        Cancel
      </button>
    </form>
  )
}
