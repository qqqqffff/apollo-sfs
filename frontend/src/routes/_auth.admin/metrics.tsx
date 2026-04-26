import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { getMetricsHistoryByHours } from '../../api/admin'
import { useMetricsStream } from '../../hooks/useMetricsStream'
import { BarGraph } from '../../components/BarGraph'
import { LineGraph } from '../../components/LineGraph'
import type { LinePoint } from '../../components/LineGraph'

export const Route = createFileRoute('/_auth/admin/metrics')({
  component: RouteComponent,
})

const GB = 1024 ** 3

type HourWindow = 1 | 12 | 24 | 48 | 72
const HOUR_OPTIONS: HourWindow[] = [1, 12, 24, 48, 72]

function RouteComponent() {
  const { snapshots, connected } = useMetricsStream()
  const [hours, setHours] = useState<HourWindow>(12)

  const latest = snapshots[snapshots.length - 1]

  const cpuPct = latest?.cpu_percent ?? 0
  const memPct =
    latest && latest.memory_total_bytes > 0
      ? (latest.memory_used_bytes / latest.memory_total_bytes) * 100
      : 0
  const diskUsedPct =
    latest && latest.disk_total_bytes > 0
      ? ((latest.disk_total_bytes - latest.disk_free_bytes) / latest.disk_total_bytes) * 100
      : 0

  const bars = [
    { label: 'CPU',     value: cpuPct,     color: '#f59e0b' },
    { label: 'Memory',  value: memPct,     color: '#8b5cf6',
      detail: latest ? `${(latest.memory_used_bytes / GB).toFixed(1)} / ${(latest.memory_total_bytes / GB).toFixed(1)} GB` : undefined },
    { label: 'Disk',    value: diskUsedPct, color: '#3b82f6',
      detail: latest
        ? `${((latest.disk_total_bytes - latest.disk_free_bytes) / GB).toFixed(1)} / ${(latest.disk_total_bytes / GB).toFixed(0)} GB`
        : undefined },
  ]

  const nowMs = Date.now()
  const wsPoints: LinePoint[] = snapshots
    .filter(s => new Date(s.sampled_at).getTime() >= nowMs - 60 * 60 * 1000)
    .map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.storage_total_used_bytes }))

  const { data: historySnaps } = useQuery({
    queryKey: ['admin', 'metrics', 'history', hours],
    queryFn: () => getMetricsHistoryByHours(hours),
    staleTime: 60_000,
    enabled: hours > 1,
  })

  const historyPoints: LinePoint[] = (historySnaps ?? []).map(s => ({
    x: new Date(s.sampled_at).getTime(),
    y: s.storage_total_used_bytes,
  }))

  const linePoints = hours === 1 ? wsPoints : historyPoints

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
          <StatCard label="Total users"   value={String(latest.total_user_count)} />
          <StatCard label="Active (5 min)" value={String(latest.active_user_count)} />
          <StatCard
            label="Disk used"
            value={`${((latest.disk_total_bytes - latest.disk_free_bytes) / GB).toFixed(1)} GB`}
            sub={`${diskUsedPct.toFixed(1)}% of ${(latest.disk_total_bytes / GB).toFixed(0)} GB`}
          />
          <StatCard
            label="Memory"
            value={`${(latest.memory_used_bytes / GB).toFixed(2)} GB`}
            sub={`${memPct.toFixed(1)}% of ${(latest.memory_total_bytes / GB).toFixed(1)} GB`}
          />
          {netSentRate !== null && (
            <StatCard label="Net ↑ / ↓" value={`${netSentRate} / ${netRecvRate}`} />
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

      <section>
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
            points={linePoints}
            width={Math.min(820, window.innerWidth - 80)}
            height={200}
          />
        </div>
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
