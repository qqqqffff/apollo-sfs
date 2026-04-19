import { createRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Route as AdminLayout } from '../AdminLayout'
import { getMetricsHistoryByHours } from '../../api/admin'
import { useMetricsStream } from '../../hooks/useMetricsStream'
import { BarGraph } from '../../components/BarGraph'
import { LineGraph } from '../../components/LineGraph'
import type { LinePoint } from '../../components/LineGraph'

export const Route = createRoute({
  getParentRoute: () => AdminLayout,
  path: '/admin/metrics',
  component: MetricsPage,
})

const GB = 1024 ** 3

type HourWindow = 1 | 12 | 24 | 48 | 72

const HOUR_OPTIONS: HourWindow[] = [1, 12, 24, 48, 72]

function MetricsPage() {
  const { snapshots, connected } = useMetricsStream()
  const [hours, setHours] = useState<HourWindow>(12)

  const latest = snapshots[snapshots.length - 1]

  // ── Live bar graph data ────────────────────────────────────────────────────

  const cpuPct = latest?.cpu_percent ?? 0
  const memPct =
    latest && latest.memory_total_bytes > 0
      ? (latest.memory_used_bytes / latest.memory_total_bytes) * 100
      : 0
  const storagePct =
    latest && latest.storage_total_quota_bytes > 0
      ? (latest.storage_total_used_bytes / latest.storage_total_quota_bytes) * 100
      : 0

  const bars = [
    {
      label: 'CPU',
      value: cpuPct,
      color: '#f59e0b',
    },
    {
      label: 'Memory',
      value: memPct,
      color: '#8b5cf6',
      detail:
        latest
          ? `${(latest.memory_used_bytes / GB).toFixed(1)} / ${(latest.memory_total_bytes / GB).toFixed(1)} GB`
          : undefined,
    },
    {
      label: 'Storage',
      value: storagePct,
      color: '#3b82f6',
      detail:
        latest
          ? `${(latest.storage_total_used_bytes / GB).toFixed(2)} GB used`
          : undefined,
    },
  ]

  // ── Line graph: 1-hour window from WebSocket rolling buffer ────────────────

  const nowMs = Date.now()
  const oneHourMs = 60 * 60 * 1000

  const wsPoints: LinePoint[] = snapshots
    .filter(s => new Date(s.sampled_at).getTime() >= nowMs - oneHourMs)
    .map(s => ({
      x: new Date(s.sampled_at).getTime(),
      y: s.storage_total_used_bytes,
    }))

  // ── Line graph: historical data from REST for longer windows ──────────────

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

  // ── Network delta (bytes/sec between last two frames) ─────────────────────

  let netSentRate: string | null = null
  let netRecvRate: string | null = null
  if (snapshots.length >= 2) {
    const prev = snapshots[snapshots.length - 2]
    const curr = snapshots[snapshots.length - 1]
    const dtMs = new Date(curr.sampled_at).getTime() - new Date(prev.sampled_at).getTime()
    if (dtMs > 0) {
      const sentPerSec = ((curr.network_bytes_sent - prev.network_bytes_sent) / dtMs) * 1000
      const recvPerSec = ((curr.network_bytes_recv - prev.network_bytes_recv) / dtMs) * 1000
      netSentRate = formatBytesPerSec(sentPerSec)
      netRecvRate = formatBytesPerSec(recvPerSec)
    }
  }

  return (
    <div style={{ maxWidth: 900 }}>
      {/* header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 24,
        }}
      >
        <h2 style={{ margin: 0 }}>System Metrics</h2>
        <span
          style={{
            fontSize: 12,
            padding: '2px 8px',
            borderRadius: 10,
            background: connected ? '#dcfce7' : '#fee2e2',
            color: connected ? '#15803d' : '#dc2626',
          }}
        >
          {connected ? 'Live' : 'Reconnecting…'}
        </span>
      </div>

      {/* stat cards */}
      {latest && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 12,
            marginBottom: 32,
          }}
        >
          <StatCard label="Total users" value={String(latest.total_user_count)} />
          <StatCard label="Active (5 min)" value={String(latest.active_user_count)} />
          <StatCard
            label="Storage used"
            value={`${(latest.storage_total_used_bytes / GB).toFixed(2)} GB`}
            sub={
              latest.storage_total_quota_bytes > 0
                ? `${storagePct.toFixed(1)}% of ${(latest.storage_total_quota_bytes / GB).toFixed(0)} GB quota`
                : undefined
            }
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

      {/* live bar chart */}
      <section style={{ marginBottom: 40 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15, color: '#374151' }}>
          Live utilisation
        </h3>
        <div
          style={{
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            padding: '16px 24px',
          }}
        >
          {snapshots.length === 0 ? (
            <p style={{ color: '#9ca3af', fontSize: 13, margin: 0 }}>
              Waiting for first snapshot…
            </p>
          ) : (
            <BarGraph bars={bars} height={220} />
          )}
        </div>
      </section>

      {/* storage history line chart */}
      <section>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 12,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 15, color: '#374151' }}>
            Storage over time
          </h3>
          <div style={{ display: 'flex', gap: 4 }}>
            {HOUR_OPTIONS.map(h => (
              <button
                key={h}
                onClick={() => setHours(h)}
                style={{
                  padding: '3px 10px',
                  borderRadius: 6,
                  border: '1px solid',
                  fontSize: 12,
                  cursor: 'pointer',
                  background: hours === h ? '#3b82f6' : 'transparent',
                  borderColor: hours === h ? '#3b82f6' : '#d1d5db',
                  color: hours === h ? '#fff' : '#374151',
                }}
              >
                {h}hr
              </button>
            ))}
          </div>
        </div>
        <div
          style={{
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            padding: '16px 24px',
          }}
        >
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

function StatCard({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        padding: '12px 16px',
      }}
    >
      <div style={{ color: '#9ca3af', fontSize: 11, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
      {sub && (
        <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 2 }}>{sub}</div>
      )}
    </div>
  )
}

function formatBytesPerSec(bps: number): string {
  if (bps < 0) bps = 0
  const KB = 1024
  const MB = KB * 1024
  if (bps >= MB) return `${(bps / MB).toFixed(1)} MB/s`
  if (bps >= KB) return `${(bps / KB).toFixed(1)} KB/s`
  return `${bps.toFixed(0)} B/s`
}
