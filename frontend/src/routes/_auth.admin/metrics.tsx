import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  driveStatsQueryOptions,
  getDriveTempsHistory,
  getMetricsHistoryByHours,
  getNodeMetricsHistory,
  infrastructureQueryOptions,
  pingServer,
  runTests,
  shutdownServer,
  speedTestQueryOptions,
  syncInfrastructure,
  triggerSpeedTest,
} from '../../api/admin'
import type { DriveFrame, DriveStat, DriveSummary, MetricsFrame, NodeFrame, NodeSummary, TestRunResponse } from '../../api/admin'
import { useMetricsStream } from '../../hooks/useMetricsStream'
import { LineGraph } from '../../components/LineGraph'
import type { LinePoint } from '../../components/LineGraph'
import { useNotification } from '../../context/NotificationContext'

export const Route = createFileRoute('/_auth/admin/metrics')({
  component: RouteComponent,
})

const GB = 1024 ** 3

// Infrastructure tree: server → node → drive.
type NodeGroup = { node: NodeSummary; drives: DriveSummary[] }
type ServerGroup = {
  serverId: string
  name: string
  isActive: boolean
  nodes: NodeGroup[]
  unassigned: DriveSummary[]
}

type HourWindow = 1 | 12 | 24 | 48 | 72
const HOUR_OPTIONS: HourWindow[] = [1, 12, 24, 48, 72]

// Per-node metrics (cpu, memory, traffic, drive_temp) graph the selected node;
// cluster metrics (users, disk, speed, ping, loss) are cluster-wide (manager uplink).
type MetricKey = 'total_users' | 'active_users' | 'disk' | 'memory' | 'traffic' | 'speed' | 'ping' | 'loss' | 'cpu' | 'drive_temp'

const NODE_METRICS: ReadonlySet<MetricKey> = new Set<MetricKey>(['cpu', 'memory', 'traffic', 'drive_temp'])

const METRIC_LABELS: Record<MetricKey, string> = {
  total_users:  'Total users',
  active_users: 'Active users',
  disk:         'Disk committed',
  memory:       'Memory',
  traffic:      'Network traffic',
  speed:        'Network speed',
  ping:         'Ping',
  loss:         'Packet loss',
  cpu:          'CPU utilization',
  drive_temp:   'Drive temperature',
}

function formatTempY(v: number): string {
  return `${v.toFixed(1)}°C`
}

function formatCount(v: number): string {
  return v.toFixed(0)
}

const INACTIVE_MS = 10 * 60 * 1000

function RouteComponent() {
  const { notify } = useNotification()
  const queryClient = useQueryClient()
  const [inactive, setInactive] = useState(false)
  const resetTimerRef = useRef<() => void>()

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    function resetTimer() {
      clearTimeout(timer)
      setInactive(false)
      timer = setTimeout(() => setInactive(true), INACTIVE_MS)
    }
    resetTimerRef.current = resetTimer
    const events = ['mousemove', 'mousedown', 'keypress', 'scroll', 'touchstart'] as const
    events.forEach(e => window.addEventListener(e, resetTimer, { passive: true }))
    resetTimer()
    return () => {
      clearTimeout(timer)
      events.forEach(e => window.removeEventListener(e, resetTimer))
    }
  }, [])

  const resume = useCallback(() => resetTimerRef.current?.(), [])

  const { frames, connected } = useMetricsStream(inactive)
  const snapshots = frames.map(f => f.cluster) // cluster (uplink + app) series
  const [hours, setHours] = useState<HourWindow>(12)
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('traffic')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [driveIdx, setDriveIdx] = useState(0)

  const { data: infraData } = useQuery({ ...infrastructureQueryOptions, enabled: !inactive })
  const { data: driveStatsData } = useQuery({ ...driveStatsQueryOptions, enabled: !inactive })
  const driveStats = driveStatsData?.stats ?? {}
  const nodes = infraData?.nodes ?? []
  const drives = infraData?.drives ?? []

  // Build the server → node → drive tree. Nodes come from the dedicated list so
  // empty nodes still render; drives attach to their node or to an "Unassigned"
  // bucket within their server when node_id is null (or the node is missing).
  const serverMap = new Map<string, ServerGroup>()
  const ensureServer = (id: string, name: string, isActive: boolean): ServerGroup => {
    let s = serverMap.get(id)
    if (!s) {
      s = { serverId: id, name, isActive, nodes: [], unassigned: [] }
      serverMap.set(id, s)
    }
    return s
  }
  const nodeMap = new Map<string, NodeGroup>()
  for (const n of nodes) {
    const s = ensureServer(n.server_id, n.server_name, n.server_is_active)
    const ng: NodeGroup = { node: n, drives: [] }
    s.nodes.push(ng)
    nodeMap.set(n.node_id, ng)
  }
  for (const d of drives) {
    const s = ensureServer(d.server_id, d.server_name, d.server_is_active)
    const ng = d.node_id ? nodeMap.get(d.node_id) : undefined
    if (ng) ng.drives.push(d)
    else s.unassigned.push(d)
  }
  const servers = Array.from(serverMap.values())

  // ── Node selection (drives the per-node hardware + traffic cards) ──────────────
  const latestFrame = frames[frames.length - 1]
  const liveNodes: NodeFrame[] = latestFrame?.nodes ?? []
  // Tabs come from registered nodes so a node with no live data still appears;
  // fall back to the live stream before infrastructure has loaded.
  const nodeTabs = nodes.length
    ? nodes.map(n => ({ id: n.node_id, hostname: n.hostname, role: n.role as string }))
    : liveNodes.map(n => ({ id: n.node_id, hostname: n.hostname, role: n.role }))
  useEffect(() => {
    if (nodeTabs.length === 0) return
    if (!selectedNodeId || !nodeTabs.some(t => t.id === selectedNodeId)) {
      setSelectedNodeId(nodeTabs[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeTabs.map(t => t.id).join(','), selectedNodeId])
  const selectedNode = liveNodes.find(n => n.node_id === selectedNodeId)
  const nodeDrives: DriveFrame[] = selectedNode?.drives ?? []
  const safeDriveIdx = nodeDrives.length ? Math.min(driveIdx, nodeDrives.length - 1) : 0
  const selectedDrive = nodeDrives[safeDriveIdx]

  // The metrics page no longer edits infrastructure by hand. A single sync
  // indexes the live swarm + MinIO and reconciles the server → node → drive tree.
  const syncInfraMutation = useMutation({
    mutationFn: syncInfrastructure,
    onSuccess: (summary) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'infrastructure'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'capacity'] })
      notify(
        'success',
        `Synced ${summary.nodes} node${summary.nodes !== 1 ? 's' : ''} and ${summary.drives} drive${summary.drives !== 1 ? 's' : ''} across ${summary.servers} server${summary.servers !== 1 ? 's' : ''}`,
      )
    },
    onError: () => notify('error', 'Infrastructure sync failed'),
  })


  const latest = snapshots[snapshots.length - 1]

  // Committed disk = physically used + quota reserved but not yet uploaded (cluster).
  const diskUsedBytes = latest ? latest.disk_total_bytes - latest.disk_free_bytes : 0
  const quotaOverheadBytes = latest
    ? Math.max(0, latest.storage_total_quota_bytes - latest.storage_total_used_bytes)
    : 0
  const diskCommittedBytes = diskUsedBytes + quotaOverheadBytes
  const diskCommittedPct =
    latest && latest.disk_total_bytes > 0
      ? (diskCommittedBytes / latest.disk_total_bytes) * 100
      : 0

  // Selected node memory (live latest frame).
  const nodeMemPct =
    selectedNode && selectedNode.memory_total_bytes > 0
      ? (selectedNode.memory_used_bytes / selectedNode.memory_total_bytes) * 100
      : 0

  const nowMs = Date.now()
  const HOUR_MS = 60 * 60 * 1000
  const tMs = (iso: string) => new Date(iso).getTime()

  // ── Cluster history (users, disk, speed, ping, loss) ──────────────────────────
  const { data: historySnaps, error: historyError } = useQuery({
    queryKey: ['admin', 'metrics', 'history', hours],
    queryFn: () => getMetricsHistoryByHours(hours),
    staleTime: 60_000,
    enabled: hours > 1 && !inactive,
    retry: 1,
  })
  useEffect(() => {
    if (historyError) notify('error', 'Failed to load metrics history')
  }, [historyError, notify])
  const histSnaps = historySnaps ?? []

  // ── Per-node history (cpu, memory, traffic) for the selected node ─────────────
  const { data: nodeHistory, error: nodeHistoryError } = useQuery({
    queryKey: ['admin', 'node-metrics', selectedNodeId, hours],
    queryFn: () => getNodeMetricsHistory(selectedNodeId!, hours),
    staleTime: 60_000,
    enabled: !!selectedNodeId && hours > 1 && !inactive,
    retry: 1,
  })
  useEffect(() => {
    if (nodeHistoryError) notify('error', 'Failed to load node metrics history')
  }, [nodeHistoryError, notify])
  const nHist = nodeHistory ?? []

  // ── Per-drive temperature history (carousel) for the selected drive ───────────
  const selectedDriveId = selectedDrive?.drive_id
  const { data: driveTempHistory } = useQuery({
    queryKey: ['admin', 'drive-temps', selectedDriveId, hours],
    queryFn: () => getDriveTempsHistory(selectedDriveId!, hours),
    staleTime: 60_000,
    enabled: !!selectedDriveId && hours > 1 && !inactive,
    retry: 1,
  })

  const { pingMs: clientPingMs, packetLossPercent: clientPacketLoss, history: clientPingHistory } = useServerPing(inactive)

  // Cluster snapshots / frames within the last hour, for live series.
  const recentSnaps = snapshots.filter(s => tMs(s.sampled_at) >= nowMs - HOUR_MS)
  const recentFrames = frames.filter(f => tMs(f.cluster.sampled_at) >= nowMs - HOUR_MS)
  const nodeIn = (f: MetricsFrame) => f.nodes.find(n => n.node_id === selectedNodeId)

  // ── CPU utilisation (per node) ──
  const wsCpuPoints: LinePoint[] = recentFrames.flatMap(f => {
    const n = nodeIn(f); return n ? [{ x: tMs(f.cluster.sampled_at), y: n.cpu_percent }] : []
  })
  const histCpuPoints: LinePoint[] = nHist.map(s => ({ x: tMs(s.sampled_at), y: s.cpu_percent }))
  const cpuPoints = hours === 1 ? wsCpuPoints : histCpuPoints

  // ── Memory (per node) ──
  const wsMemoryPoints: LinePoint[] = recentFrames.flatMap(f => {
    const n = nodeIn(f); return n ? [{ x: tMs(f.cluster.sampled_at), y: n.memory_used_bytes }] : []
  })
  const histMemoryPoints: LinePoint[] = nHist.map(s => ({ x: tMs(s.sampled_at), y: s.memory_used_bytes }))
  const memoryPoints = hours === 1 ? wsMemoryPoints : histMemoryPoints

  // ── Network traffic (per node — derived from consecutive counter diffs) ──
  const wsNetUploadPoints: LinePoint[] = []
  const wsNetDownloadPoints: LinePoint[] = []
  for (let i = 1; i < recentFrames.length; i++) {
    const prevN = nodeIn(recentFrames[i - 1]); const currN = nodeIn(recentFrames[i])
    if (!prevN || !currN) continue
    const dtMs = tMs(recentFrames[i].cluster.sampled_at) - tMs(recentFrames[i - 1].cluster.sampled_at)
    if (dtMs <= 0) continue
    const sentBps = ((currN.network_bytes_sent - prevN.network_bytes_sent) / dtMs) * 1000
    const recvBps = ((currN.network_bytes_recv - prevN.network_bytes_recv) / dtMs) * 1000
    if (sentBps < 0 || recvBps < 0) continue
    wsNetUploadPoints.push({ x: tMs(recentFrames[i].cluster.sampled_at), y: sentBps })
    wsNetDownloadPoints.push({ x: tMs(recentFrames[i].cluster.sampled_at), y: recvBps })
  }
  const histNetUploadPoints: LinePoint[] = []
  const histNetDownloadPoints: LinePoint[] = []
  for (let i = 1; i < nHist.length; i++) {
    const prev = nHist[i - 1]; const curr = nHist[i]
    const dtMs = tMs(curr.sampled_at) - tMs(prev.sampled_at)
    if (dtMs <= 0) continue
    const sentBps = ((curr.network_bytes_sent - prev.network_bytes_sent) / dtMs) * 1000
    const recvBps = ((curr.network_bytes_recv - prev.network_bytes_recv) / dtMs) * 1000
    if (sentBps < 0 || recvBps < 0) continue
    histNetUploadPoints.push({ x: tMs(curr.sampled_at), y: sentBps })
    histNetDownloadPoints.push({ x: tMs(curr.sampled_at), y: recvBps })
  }
  const netUploadPoints = hours === 1 ? wsNetUploadPoints : histNetUploadPoints
  const netDownloadPoints = hours === 1 ? wsNetDownloadPoints : histNetDownloadPoints

  // Live traffic rate text for the selected node's card (last two frames).
  let netSentRate: string | null = null
  let netRecvRate: string | null = null
  if (frames.length >= 2) {
    const prevN = nodeIn(frames[frames.length - 2]); const currN = nodeIn(frames[frames.length - 1])
    if (prevN && currN) {
      const dtMs = tMs(frames[frames.length - 1].cluster.sampled_at) - tMs(frames[frames.length - 2].cluster.sampled_at)
      if (dtMs > 0) {
        netSentRate = formatBytesPerSec(((currN.network_bytes_sent - prevN.network_bytes_sent) / dtMs) * 1000)
        netRecvRate = formatBytesPerSec(((currN.network_bytes_recv - prevN.network_bytes_recv) / dtMs) * 1000)
      }
    }
  }

  // ── Drive temperature (selected node's selected drive) ──
  const wsDriveTempPoints: LinePoint[] = selectedDriveId
    ? recentFrames.flatMap(f => {
        const d = nodeIn(f)?.drives.find(dr => dr.drive_id === selectedDriveId)
        return d && d.temp_celsius != null ? [{ x: tMs(f.cluster.sampled_at), y: d.temp_celsius }] : []
      })
    : []
  const histDriveTempPoints: LinePoint[] = (driveTempHistory ?? []).map(s => ({ x: tMs(s.sampled_at), y: s.temp_celsius }))
  const driveTempPoints = hours === 1 ? wsDriveTempPoints : histDriveTempPoints

  // ── Cluster-level series: ping, loss, speed, users, disk ──
  const wsPingPoints: LinePoint[] = recentSnaps
    .filter(s => s.server_isp_ping_ms != null)
    .map(s => ({ x: tMs(s.sampled_at), y: s.server_isp_ping_ms! }))
  const wsLossPoints: LinePoint[] = recentSnaps
    .filter(s => s.server_isp_packet_loss_percent != null)
    .map(s => ({ x: tMs(s.sampled_at), y: s.server_isp_packet_loss_percent! }))
  const histPingPoints: LinePoint[] = histSnaps
    .filter(s => s.server_isp_ping_ms != null)
    .map(s => ({ x: tMs(s.sampled_at), y: s.server_isp_ping_ms! }))
  const histLossPoints: LinePoint[] = histSnaps
    .filter(s => s.server_isp_packet_loss_percent != null)
    .map(s => ({ x: tMs(s.sampled_at), y: s.server_isp_packet_loss_percent! }))
  const serverPingPoints = hours === 1 ? wsPingPoints : histPingPoints
  // For 1hr live view, fall back to HTTP pings if server ICMP unavailable.
  const netPingPoints = hours === 1
    ? (serverPingPoints.length >= 2 ? serverPingPoints : clientPingHistory)
    : serverPingPoints
  const netLossPoints = hours === 1 ? wsLossPoints : histLossPoints

  const wsSpeedUploadPoints: LinePoint[] = recentSnaps
    .filter(s => s.speed_test_upload_mbps != null)
    .map(s => ({ x: tMs(s.sampled_at), y: s.speed_test_upload_mbps! }))
  const wsSpeedDownloadPoints: LinePoint[] = recentSnaps
    .filter(s => s.speed_test_download_mbps != null)
    .map(s => ({ x: tMs(s.sampled_at), y: s.speed_test_download_mbps! }))
  const histSpeedUploadPoints: LinePoint[] = histSnaps
    .filter(s => s.speed_test_upload_mbps != null)
    .map(s => ({ x: tMs(s.sampled_at), y: s.speed_test_upload_mbps! }))
  const histSpeedDownloadPoints: LinePoint[] = histSnaps
    .filter(s => s.speed_test_download_mbps != null)
    .map(s => ({ x: tMs(s.sampled_at), y: s.speed_test_download_mbps! }))
  const speedUploadPoints = hours === 1 ? wsSpeedUploadPoints : histSpeedUploadPoints
  const speedDownloadPoints = hours === 1 ? wsSpeedDownloadPoints : histSpeedDownloadPoints

  const wsUsersPoints: LinePoint[] = recentSnaps.map(s => ({ x: tMs(s.sampled_at), y: s.total_user_count }))
  const wsActiveUsersPoints: LinePoint[] = recentSnaps.map(s => ({ x: tMs(s.sampled_at), y: s.active_user_count }))
  const wsDiskPoints: LinePoint[] = recentSnaps.map(s => ({
    x: tMs(s.sampled_at),
    y: (s.disk_total_bytes - s.disk_free_bytes) + Math.max(0, s.storage_total_quota_bytes - s.storage_total_used_bytes),
  }))
  const histUsersPoints: LinePoint[] = histSnaps.map(s => ({ x: tMs(s.sampled_at), y: s.total_user_count }))
  const histActiveUsersPoints: LinePoint[] = histSnaps.map(s => ({ x: tMs(s.sampled_at), y: s.active_user_count }))
  const histDiskPoints: LinePoint[] = histSnaps.map(s => ({
    x: tMs(s.sampled_at),
    y: (s.disk_total_bytes - s.disk_free_bytes) + Math.max(0, s.storage_total_quota_bytes - s.storage_total_used_bytes),
  }))
  const usersPoints = hours === 1 ? wsUsersPoints : histUsersPoints
  const activeUsersPoints = hours === 1 ? wsActiveUsersPoints : histActiveUsersPoints
  const diskPoints = hours === 1 ? wsDiskPoints : histDiskPoints

  const { data: speedTest, error: speedTestError } = useQuery({
    ...speedTestQueryOptions,
    retry: false,
    enabled: !inactive,
  })

  useEffect(() => {
    if (speedTestError) notify('error', 'Failed to load speed test result')
  }, [speedTestError, notify])

  const speedTestMutation = useMutation({
    mutationFn: triggerSpeedTest,
    onSuccess: (data) => {
      queryClient.setQueryData(speedTestQueryOptions.queryKey, data)
    },
    onError: () => notify('error', 'Speed test failed'),
  })

  // Prefer live speed test data from the WS stream; fall back to REST query result.
  const liveSpeedTest: SpeedTestResult | undefined =
    latest?.speed_test_upload_mbps != null
      ? {
          upload_mbps: latest.speed_test_upload_mbps!,
          download_mbps: latest.speed_test_download_mbps!,
          size_bytes: 0,
          tested_at: latest.speed_test_tested_at!,
          error: latest.speed_test_error ?? undefined,
        }
      : speedTest

  const [testResult, setTestResult] = useState<TestRunResponse | null>(null)
  const [testOutputOpen, setTestOutputOpen] = useState(false)
  const [shutdownConfirm, setShutdownConfirm] = useState(false)

  const shutdownMutation = useMutation({
    mutationFn: shutdownServer,
    onError: () => notify('error', 'Shutdown request failed'),
  })

  const runTestsMutation = useMutation({
    mutationFn: runTests,
    onSuccess: (data) => setTestResult(data),
    onError: (err: { status?: number }) => {
      if (err.status === 422) {
        // 422 still returns the full result body — handled via onSuccess for non-2xx
      } else {
        notify('error', 'Failed to run tests')
      }
    },
  })

  const graphW = Math.min(820, window.innerWidth - 80)

  // For windows >= 24 hr the x-axis spans multiple calendar days, so show
  // the date alongside the time to avoid ambiguity.
  const formatGraphX = hours >= 24
    ? (ms: number) => {
        const d = new Date(ms)
        return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) +
          ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }
    : undefined

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-900 m-0">System Metrics</h2>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
            inactive ? 'bg-gray-100 text-gray-500' :
            connected ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
          }`}>
            {inactive ? 'Disconnected' : connected ? 'Live' : 'Reconnecting…'}
          </span>
          {inactive && (
            <button
              onClick={resume}
              className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer bg-transparent border border-blue-200 hover:border-blue-400 rounded px-2 py-0.5 transition-colors"
            >
              Resume
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {shutdownConfirm ? (
            <>
              <span className="text-xs text-red-600 font-medium">Stop all containers and power off?</span>
              <button
                onClick={() => { shutdownMutation.mutate(); setShutdownConfirm(false) }}
                disabled={shutdownMutation.isPending}
                className="text-xs bg-red-600 text-white rounded px-2 py-1 disabled:opacity-50 cursor-pointer"
              >
                Confirm
              </button>
              <button
                onClick={() => setShutdownConfirm(false)}
                className="text-xs text-gray-500 hover:text-gray-800 cursor-pointer bg-transparent border border-gray-200 hover:border-gray-400 rounded px-2 py-1 transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setShutdownConfirm(true)}
              className="text-xs text-red-500 hover:text-red-700 cursor-pointer bg-transparent border border-red-200 hover:border-red-400 rounded px-2 py-1 transition-colors"
            >
              Shutdown server
            </button>
          )}
        </div>
      </div>

      {latest && (
        <>
          {/* ── Node hardware (per selected node) ─────────────────────────── */}
          <section className="mb-8">
            <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
              <h3 className="text-sm font-semibold text-gray-600 m-0">Node hardware</h3>
              <NodeTabs
                tabs={nodeTabs}
                selectedId={selectedNodeId}
                onSelect={(id) => { setSelectedNodeId(id); setDriveIdx(0) }}
              />
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              <CpuCard
                percent={selectedNode?.cpu_percent ?? null}
                tempCelsius={selectedNode?.cpu_temp_celsius ?? null}
                online={selectedNode?.online ?? false}
                selected={selectedMetric === 'cpu'}
                onClick={() => setSelectedMetric('cpu')}
              />
              <StatCard
                label="Memory"
                value={selectedNode ? `${(selectedNode.memory_used_bytes / GB).toFixed(2)} GB` : '—'}
                sub={selectedNode ? `${nodeMemPct.toFixed(1)}% of ${(selectedNode.memory_total_bytes / GB).toFixed(1)} GB` : 'no live data'}
                selected={selectedMetric === 'memory'}
                onClick={() => setSelectedMetric('memory')}
              />
              <DriveCapacityCard drives={nodeDrives} />
              <DriveTempCarousel
                drives={nodeDrives}
                index={safeDriveIdx}
                onIndex={setDriveIdx}
                selected={selectedMetric === 'drive_temp'}
                onClick={() => setSelectedMetric('drive_temp')}
              />
            </div>
          </section>

          {/* ── Node network (traffic per node, uplink shared) ────────────── */}
          <section className="mb-8">
            <h3 className="text-sm font-semibold text-gray-600 m-0 mb-3">Node network</h3>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              <NetworkTrafficCard
                sent={netSentRate ?? '—'}
                recv={netRecvRate ?? '—'}
                selected={selectedMetric === 'traffic'}
                onClick={() => setSelectedMetric('traffic')}
              />
              <SpeedTestCard result={liveSpeedTest} onRun={() => speedTestMutation.mutate()} pending={speedTestMutation.isPending} selected={selectedMetric === 'speed'} onClick={() => setSelectedMetric('speed')} />
              <PingCard
                serverMs={latest?.server_isp_ping_ms ?? null}
                clientMs={clientPingMs}
                selected={selectedMetric === 'ping'}
                onClick={() => setSelectedMetric('ping')}
              />
              <PacketLossCard
                serverLoss={latest?.server_isp_packet_loss_percent ?? null}
                clientLoss={clientPacketLoss}
                selected={selectedMetric === 'loss'}
                onClick={() => setSelectedMetric('loss')}
              />
            </div>
          </section>

          {/* ── Users & storage (cluster-wide) ────────────────────────────── */}
          <section className="mb-8">
            <h3 className="text-sm font-semibold text-gray-600 m-0 mb-3">Users &amp; storage</h3>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              <StatCard
                label="Total users"
                value={String(latest.total_user_count)}
                selected={selectedMetric === 'total_users'}
                onClick={() => setSelectedMetric('total_users')}
              />
              <StatCard
                label="Active (5 min)"
                value={String(latest.active_user_count)}
                selected={selectedMetric === 'active_users'}
                onClick={() => setSelectedMetric('active_users')}
              />
              <StatCard
                label="Disk committed"
                value={`${(diskCommittedBytes / GB).toFixed(1)} GB`}
                sub={`${diskCommittedPct.toFixed(1)}% of ${(latest.disk_total_bytes / GB).toFixed(0)} GB`}
                selected={selectedMetric === 'disk'}
                onClick={() => setSelectedMetric('disk')}
              />
            </div>
          </section>
        </>
      )}

      <section className="mb-10">
        <div className="flex items-center gap-3 mb-3">
          <h3 className="text-sm font-semibold text-gray-600 m-0">
            {METRIC_LABELS[selectedMetric]}
            {NODE_METRICS.has(selectedMetric) && selectedNode ? ` · ${selectedNode.hostname}` : ''}
            {selectedMetric === 'drive_temp' && selectedDrive ? ` · ${selectedDrive.label}` : ''}
            {' '}over time
          </h3>
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
          {selectedMetric === 'traffic' && (
            <div className="flex flex-col gap-4">
              <div>
                <div className="text-xs text-gray-400 mb-2">↑ Upload</div>
                <LineGraph points={netUploadPoints} width={graphW} height={160} color="#3b82f6" formatY={formatBytesPerSec} formatX={formatGraphX} />
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-2">↓ Download</div>
                <LineGraph points={netDownloadPoints} width={graphW} height={160} color="#10b981" formatY={formatBytesPerSec} formatX={formatGraphX} />
              </div>
            </div>
          )}
          {selectedMetric === 'speed' && (
            <div className="flex flex-col gap-4">
              <div>
                <div className="text-xs text-gray-400 mb-2">↑ Upload (Mbps)</div>
                <LineGraph points={speedUploadPoints} width={graphW} height={160} color="#3b82f6" formatY={(v) => `${v.toFixed(1)} Mb/s`} formatX={formatGraphX} />
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-2">↓ Download (Mbps)</div>
                <LineGraph points={speedDownloadPoints} width={graphW} height={160} color="#10b981" formatY={(v) => `${v.toFixed(1)} Mb/s`} formatX={formatGraphX} />
              </div>
            </div>
          )}
          {selectedMetric === 'ping' && (
            <LineGraph points={netPingPoints} width={graphW} height={200} color="#f59e0b" formatY={(v) => `${v.toFixed(1)} ms`} formatX={formatGraphX} />
          )}
          {selectedMetric === 'loss' && (
            <LineGraph points={netLossPoints} width={graphW} height={200} color="#ef4444" formatY={(v) => `${v.toFixed(1)}%`} formatX={formatGraphX} />
          )}
          {selectedMetric === 'total_users' && (
            <LineGraph points={usersPoints} width={graphW} height={200} color="#8b5cf6" formatY={formatCount} formatX={formatGraphX} />
          )}
          {selectedMetric === 'active_users' && (
            <LineGraph points={activeUsersPoints} width={graphW} height={200} color="#06b6d4" formatY={formatCount} formatX={formatGraphX} />
          )}
          {selectedMetric === 'disk' && (
            <LineGraph points={diskPoints} width={graphW} height={200} color="#3b82f6" formatX={formatGraphX} />
          )}
          {selectedMetric === 'memory' && (
            <LineGraph points={memoryPoints} width={graphW} height={200} color="#8b5cf6" formatX={formatGraphX} />
          )}
          {selectedMetric === 'cpu' && (
            <LineGraph points={cpuPoints} width={graphW} height={200} color="#f59e0b" formatY={(v) => `${v.toFixed(0)}%`} formatX={formatGraphX} />
          )}
          {selectedMetric === 'drive_temp' && (
            <LineGraph points={driveTempPoints} width={graphW} height={200} color="#10b981" formatY={formatTempY} formatX={formatGraphX} />
          )}
        </div>
      </section>

      <section className="mb-10">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-600 m-0">Tests</h3>
          <button
            onClick={() => runTestsMutation.mutate()}
            disabled={runTestsMutation.isPending}
            className="text-xs bg-blue-600 text-white rounded px-2 py-1 disabled:opacity-50 cursor-pointer"
          >
            {runTestsMutation.isPending ? 'Running…' : 'Run tests'}
          </button>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
          {!testResult && !runTestsMutation.isPending && (
            <p className="text-sm text-gray-400 m-0">No test run yet. Click "Run tests" to execute the suite.</p>
          )}
          {runTestsMutation.isPending && (
            <p className="text-sm text-gray-400 m-0 animate-pulse">Running test suites…</p>
          )}
          {testResult && (
            <div className="flex flex-col gap-3">
              <TestSuiteRow label="Backend" entry={testResult.backend} />
              <TestSuiteRow label="Frontend" entry={testResult.frontend} />
              <TestSuiteRow label="Frontend E2E" entry={testResult.frontend_e2e} />
              <button
                onClick={() => setTestOutputOpen(o => !o)}
                className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 text-left w-fit"
              >
                {testOutputOpen ? '▲ Hide output' : '▼ Show output'}
              </button>
              {testOutputOpen && (
                <div className="flex flex-col gap-3">
                  {testResult.backend.enabled && testResult.backend.result && (
                    <OutputBlock label="Backend" output={testResult.backend.result.output} />
                  )}
                  {testResult.frontend.enabled && testResult.frontend.result && (
                    <OutputBlock label="Frontend" output={testResult.frontend.result.output} />
                  )}
                  {testResult.frontend_e2e.enabled && testResult.frontend_e2e.result && (
                    <OutputBlock label="Frontend E2E" output={testResult.frontend_e2e.result.output} />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-600 m-0">Infrastructure</h3>
            <span className="text-xs text-gray-400">auto-detected from the swarm</span>
          </div>
          <button
            onClick={() => syncInfraMutation.mutate()}
            disabled={syncInfraMutation.isPending}
            className="text-xs bg-blue-600 text-white rounded px-2 py-1 disabled:opacity-50 cursor-pointer"
            title="Index all swarm nodes and drives (roles, capacity, fast/standard) from the live cluster"
          >
            {syncInfraMutation.isPending ? 'Syncing…' : 'Sync infrastructure'}
          </button>
        </div>
        {servers.length === 0 ? (
          <p className="text-sm text-gray-400">No infrastructure indexed yet. Click "Sync infrastructure" to detect the swarm.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {servers.map((srv) => (
              <div key={srv.serverId} className="bg-white border border-gray-200 rounded-xl px-5 py-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${srv.isActive ? 'bg-green-500' : 'bg-gray-300'}`} />
                  <span className="font-medium text-gray-800 text-sm">{srv.name}</span>
                  {!srv.isActive && <span className="text-xs text-gray-400">(inactive)</span>}
                </div>
                <div className="flex flex-col gap-3">
                  {srv.nodes.length === 0 && srv.unassigned.length === 0 && (
                    <p className="text-xs text-gray-400 m-0">No nodes detected on this server.</p>
                  )}
                  {srv.nodes.map((ng) => (
                    <NodeBlock key={ng.node.node_id} group={ng} driveStats={driveStats} />
                  ))}
                  {srv.unassigned.length > 0 && (
                    <div className="border border-dashed border-gray-200 rounded-lg px-3 py-3">
                      <div className="text-xs font-medium text-gray-400 mb-2">Unassigned drives (no node)</div>
                      <div className="flex flex-col gap-3">
                        {srv.unassigned.map((d) => (
                          <DriveBar key={d.drive_id} drive={d} stat={driveStats[d.drive_id]} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function StatCard({ label, value, sub, selected, onClick }: { label: string; value: string; sub?: string; selected?: boolean; onClick?: () => void }) {
  return (
    <div
      className={`bg-white border rounded-xl px-4 py-3 transition-colors ${onClick ? 'cursor-pointer' : ''} ${selected ? 'border-blue-500 ring-1 ring-blue-500' : onClick ? 'border-gray-200 hover:border-gray-300' : 'border-gray-200'}`}
      onClick={onClick}
    >
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="text-xl font-semibold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}

import type { SpeedTestResult, TestSuiteEntry } from '../../api/admin'

function SpeedTestCard({ result, onRun, pending, selected, onClick }: {
  result: SpeedTestResult | undefined
  onRun: () => void
  pending: boolean
  selected?: boolean
  onClick?: () => void
}) {
  return (
    <div
      className={`bg-white border rounded-xl px-4 py-3 transition-colors ${onClick ? 'cursor-pointer' : ''} ${selected ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-gray-400">Network speed</div>
        <button
          onClick={onRun}
          disabled={pending}
          className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-40 cursor-pointer bg-transparent border-0"
        >
          {pending ? '…' : 'Run'}
        </button>
      </div>
      {result && !result.error ? (
        <>
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-gray-500">↑ Upload</span>
              <span className="text-sm font-semibold text-gray-900 tabular-nums">{result.upload_mbps.toFixed(1)} Mb/s</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-gray-500">↓ Download</span>
              <span className="text-sm font-semibold text-gray-900 tabular-nums">{result.download_mbps.toFixed(1)} Mb/s</span>
            </div>
          </div>
          <div className="text-xs text-gray-400 mt-1">
            {new Date(result.tested_at).toLocaleTimeString()}
          </div>
        </>
      ) : result?.error ? (
        <div className="text-xs text-red-500 mt-1">{result.error}</div>
      ) : (
        <div className="text-sm font-semibold text-gray-400">{pending ? 'Testing…' : '—'}</div>
      )}
    </div>
  )
}

// parseSuiteDetail extracts a human-readable count summary from test runner output.
// Go: "ok  apollo-sfs.com/api/tests  1.234s" lines → "N suites passing"
// Jest: "Test Suites: 3 passed, 3 total\nTests: 42 passed, 42 total"
// Playwright: "38 passed (12s)" or "35 passed, 3 failed"
function parseSuiteDetail(output: string, passed: boolean): string | null {
  if (!output) return null

  // Go — count "ok" lines
  const goOk = (output.match(/^ok\s+\S+/gm) ?? []).length
  const goFail = (output.match(/^FAIL\s+\S+/gm) ?? []).length
  if (goOk > 0 || goFail > 0) {
    return passed
      ? `${goOk} suite${goOk !== 1 ? 's' : ''} passing`
      : `${goFail} suite${goFail !== 1 ? 's' : ''} failing · ${goOk} passing`
  }

  // Jest — "Test Suites: X passed, Y total" and "Tests: A passed, B total"
  const suiteMatch = output.match(/Test Suites:\s+(?:(\d+) failed,\s*)?(\d+) passed,\s*(\d+) total/)
  const testMatch  = output.match(/Tests:\s+(?:(\d+) failed,\s*)?(\d+) passed,\s*(\d+) total/)
  if (suiteMatch && testMatch) {
    const suiteFail = parseInt(suiteMatch[1] ?? '0')
    const suitePass = parseInt(suiteMatch[2])
    const testFail  = parseInt(testMatch[1]  ?? '0')
    const testPass  = parseInt(testMatch[2])
    const sTotal = suitePass + suiteFail
    const tTotal = testPass  + testFail
    if (passed) return `${suitePass}/${sTotal} suite${sTotal !== 1 ? 's' : ''} · ${testPass}/${tTotal} tests passing`
    return `${suiteFail} suite${suiteFail !== 1 ? 's' : ''} failing · ${testFail} test${testFail !== 1 ? 's' : ''} failing`
  }

  // Playwright — "X passed" or "X passed, Y failed"
  const pwPass = output.match(/(\d+) passed/)
  const pwFail = output.match(/(\d+) failed/)
  if (pwPass) {
    const p = parseInt(pwPass[1])
    const f = pwFail ? parseInt(pwFail[1]) : 0
    if (passed) return `${p} test${p !== 1 ? 's' : ''} passing`
    return f > 0
      ? `${f} test${f !== 1 ? 's' : ''} failing · ${p} passing`
      : `${p} test${p !== 1 ? 's' : ''} passing`
  }

  return null
}

function TestSuiteRow({ label, entry }: { label: string; entry: TestSuiteEntry }) {
  if (!entry.enabled) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <span className="w-2 h-2 rounded-full bg-gray-200 shrink-0" />
        <span className="font-medium text-gray-500">{label}</span>
        <span className="text-xs">{entry.message ?? 'disabled'}</span>
      </div>
    )
  }
  const passed = entry.result?.passed
  const detail = entry.result ? parseSuiteDetail(entry.result.output, !!passed) : null
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`w-2 h-2 rounded-full shrink-0 ${passed ? 'bg-green-500' : 'bg-red-500'}`} />
      <span className="font-medium text-gray-700">{label}</span>
      <span className={`text-xs font-medium ${passed ? 'text-green-600' : 'text-red-600'}`}>
        {passed ? 'PASS' : 'FAIL'}
      </span>
      {detail && (
        <span className="text-xs text-gray-500">{detail}</span>
      )}
      {entry.result && (
        <span className="text-xs text-gray-400">{entry.result.duration_ms} ms</span>
      )}
    </div>
  )
}

function OutputBlock({ label, output }: { label: string; output: string }) {
  return (
    <div>
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap max-h-60 overflow-y-auto m-0">
        {output || '(no output)'}
      </pre>
    </div>
  )
}

function tempColor(c: number): string {
  if (c >= 60) return 'text-red-600'
  if (c >= 45) return 'text-amber-500'
  return 'text-emerald-600'
}

// NodeTabs is the per-node selector that drives the hardware + traffic cards.
function NodeTabs({ tabs, selectedId, onSelect }: {
  tabs: { id: string; hostname: string; role: string }[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  if (tabs.length <= 1) return null
  return (
    <div className="flex gap-1 flex-wrap">
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onSelect(t.id)}
          title={t.role}
          className={`px-2.5 py-1 text-xs rounded-md border cursor-pointer transition-colors ${
            t.id === selectedId
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
          }`}
        >
          {t.hostname}
        </button>
      ))}
    </div>
  )
}

// CpuCard merges utilisation (%) and temperature (°C) for the selected node.
function CpuCard({ percent, tempCelsius, online, selected, onClick }: {
  percent: number | null
  tempCelsius: number | null
  online: boolean
  selected?: boolean
  onClick?: () => void
}) {
  return (
    <div
      className={`bg-white border rounded-xl px-4 py-3 cursor-pointer transition-colors ${selected ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
      onClick={onClick}
    >
      <div className="text-xs text-gray-400 mb-2">CPU</div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-gray-500">Utilization</span>
          <span className="text-sm font-semibold text-gray-900 tabular-nums shrink-0">
            {percent != null ? `${percent.toFixed(0)}%` : '—'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-gray-500">Temperature</span>
          <span className={`text-sm font-semibold tabular-nums shrink-0 ${tempCelsius != null ? tempColor(tempCelsius) : 'text-gray-400'}`}>
            {tempCelsius != null ? `${tempCelsius.toFixed(1)}°C` : '—'}
          </span>
        </div>
      </div>
      {!online && <div className="text-xs text-gray-400 mt-1">no live data</div>}
    </div>
  )
}

// DriveCapacityCard summarises the selected node's drive capacity/usage.
function DriveCapacityCard({ drives }: { drives: DriveFrame[] }) {
  const total = drives.reduce((s, d) => s + d.total_bytes, 0)
  const used = drives.reduce((s, d) => s + d.used_bytes, 0)
  const pct = total > 0 ? (used / total) * 100 : 0
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
      <div className="text-xs text-gray-400 mb-1">Drive capacity</div>
      {drives.length === 0 ? (
        <div className="text-sm font-semibold text-gray-400">no live data</div>
      ) : (
        <>
          <div className="text-xl font-semibold text-gray-900">{fmtCapacity(used)}</div>
          <div className="text-xs text-gray-400 mt-0.5">
            {pct.toFixed(1)}% of {fmtCapacity(total)} · {drives.length} drive{drives.length !== 1 ? 's' : ''}
          </div>
        </>
      )}
    </div>
  )
}

// DriveTempCarousel pages through the selected node's drives, one temperature
// per slide. Replaces the old NVMe-temps + drive-temp cards.
function DriveTempCarousel({ drives, index, onIndex, selected, onClick }: {
  drives: DriveFrame[]
  index: number
  onIndex: (i: number) => void
  selected?: boolean
  onClick?: () => void
}) {
  const has = drives.length > 0
  const d = has ? drives[Math.min(index, drives.length - 1)] : undefined
  const step = (delta: number, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!has) return
    onIndex((index + delta + drives.length) % drives.length)
  }
  return (
    <div
      className={`bg-white border rounded-xl px-4 py-3 cursor-pointer transition-colors ${selected ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-gray-400">Drive temp</div>
        {drives.length > 1 && (
          <div className="flex items-center gap-1">
            <button onClick={(e) => step(-1, e)} className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 px-1" title="Previous drive">‹</button>
            <span className="text-xs text-gray-400 tabular-nums">{index + 1}/{drives.length}</span>
            <button onClick={(e) => step(1, e)} className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 px-1" title="Next drive">›</button>
          </div>
        )}
      </div>
      {d ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-600 font-medium truncate" title={d.label}>{d.label}</span>
            <span className={`text-lg font-semibold tabular-nums shrink-0 ${d.temp_celsius != null ? tempColor(d.temp_celsius) : 'text-gray-400'}`}>
              {d.temp_celsius != null ? `${d.temp_celsius.toFixed(1)}°C` : '—'}
            </span>
          </div>
          <div className="text-xs text-gray-400 mt-0.5">{d.drive_type === 'nvme' ? 'Fast' : 'Standard'}</div>
        </>
      ) : (
        <div className="text-sm font-semibold text-gray-400">no live data</div>
      )}
    </div>
  )
}

function pingColor(ms: number | null): string {
  if (ms == null) return 'text-gray-900'
  if (ms >= 150) return 'text-red-600'
  if (ms >= 60) return 'text-amber-500'
  return 'text-emerald-600'
}

function lossColor(pct: number | null): string {
  if (pct == null) return 'text-gray-900'
  if (pct >= 10) return 'text-red-600'
  if (pct >= 1) return 'text-amber-500'
  return 'text-emerald-600'
}

function PingCard({ serverMs, clientMs, selected, onClick }: { serverMs: number | null; clientMs: number | null; selected?: boolean; onClick?: () => void }) {
  return (
    <div
      className={`bg-white border rounded-xl px-4 py-3 cursor-pointer transition-colors ${selected ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
      onClick={onClick}
    >
      <div className="text-xs text-gray-400 mb-2">Ping</div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-gray-500">Server → ISP</span>
          <span className={`text-sm font-semibold tabular-nums shrink-0 ${pingColor(serverMs)}`}>
            {serverMs != null ? `${serverMs.toFixed(1)} ms` : '—'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-gray-500">Client → Server</span>
          <span className={`text-sm font-semibold tabular-nums shrink-0 ${pingColor(clientMs)}`}>
            {clientMs != null ? `${clientMs.toFixed(1)} ms` : '—'}
          </span>
        </div>
      </div>
    </div>
  )
}

function PacketLossCard({ serverLoss, clientLoss, selected, onClick }: { serverLoss: number | null; clientLoss: number; selected?: boolean; onClick?: () => void }) {
  return (
    <div
      className={`bg-white border rounded-xl px-4 py-3 cursor-pointer transition-colors ${selected ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
      onClick={onClick}
    >
      <div className="text-xs text-gray-400 mb-2">Packet loss</div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-gray-500">Server → ISP</span>
          <span className={`text-sm font-semibold tabular-nums shrink-0 ${lossColor(serverLoss)}`}>
            {serverLoss != null ? `${serverLoss.toFixed(1)}%` : '—'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-gray-500">Client → Server</span>
          <span className={`text-sm font-semibold tabular-nums shrink-0 ${lossColor(clientLoss)}`}>
            {clientLoss.toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  )
}

function NetworkTrafficCard({ sent, recv, selected, onClick }: { sent: string; recv: string; selected?: boolean; onClick?: () => void }) {
  return (
    <div
      className={`bg-white border rounded-xl px-4 py-3 cursor-pointer transition-colors ${selected ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
      onClick={onClick}
    >
      <div className="text-xs text-gray-400 mb-2">Network traffic</div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-gray-500">↑ Upload</span>
          <span className="text-sm font-semibold text-gray-900 tabular-nums shrink-0">{sent}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-gray-500">↓ Download</span>
          <span className="text-sm font-semibold text-gray-900 tabular-nums shrink-0">{recv}</span>
        </div>
      </div>
    </div>
  )
}

const PING_HISTORY_MS = 60 * 60 * 1000 // keep up to 1 hour of probe history for the graph

function useServerPing(paused = false) {
  const [result, setResult] = useState<{ pingMs: number | null; packetLossPercent: number; history: LinePoint[] }>({
    pingMs: null,
    packetLossPercent: 0,
    history: [],
  })
  const probesRef = useRef<Array<{ t: number; rtt: number | null }>>([])

  useEffect(() => {
    if (paused) return

    async function probe() {
      let rtt: number | null = null
      try {
        rtt = await pingServer()
      } catch {
        // timeout or network error — counts as lost
      }
      const now = Date.now()
      const cutoff = now - PING_HISTORY_MS
      probesRef.current = [...probesRef.current, { t: now, rtt }].filter(p => p.t >= cutoff)
      const probes = probesRef.current
      const successful = probes.filter((p): p is { t: number; rtt: number } => p.rtt !== null)
      setResult({
        pingMs: successful.length > 0
          ? successful.reduce((s, v) => s + v.rtt, 0) / successful.length
          : null,
        packetLossPercent: ((probes.length - successful.length) / probes.length) * 100,
        history: successful.map(p => ({ x: p.t, y: p.rtt })),
      })
    }

    probe()
    const id = setInterval(probe, 5000)
    return () => clearInterval(id)
  }, [paused])

  return result
}

function formatBytesPerSec(bps: number): string {
  if (bps < 0) bps = 0
  const KB = 1024, MB = KB * 1024
  if (bps >= MB) return `${(bps / MB).toFixed(1)} MB/s`
  if (bps >= KB) return `${(bps / KB).toFixed(1)} KB/s`
  return `${bps.toFixed(0)} B/s`
}

function fmtCapacity(bytes: number): string {
  const gb = bytes / GB
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(0)} GB`
}

// DriveBar renders a single drive read-only: its label, tier (Fast/Standard),
// bucket, temperature, and a capacity/usage bar. Drives are detected by the
// infrastructure sync, so there are no per-drive controls.
function DriveBar({ drive, stat }: {
  drive: DriveSummary
  stat?: DriveStat
}) {
  const syncRequired = drive.capacity_bytes === 0
  const overAllocated = !syncRequired && drive.allocated_quota_bytes > drive.capacity_bytes
  // When the drive's own mount was discovered, prefer its live figures for
  // total/used/free; otherwise fall back to the capacity stored in the DB.
  const live = stat?.online ?? false
  const totalBytes = live ? stat!.total_bytes : drive.capacity_bytes
  const usedBytes = live ? stat!.used_bytes : drive.used_bytes
  const cap = totalBytes || 1
  const allocPct = Math.min(100, (drive.allocated_quota_bytes / cap) * 100)
  const usedPct = Math.min(100, (usedBytes / cap) * 100)
  const temp = stat?.temp_celsius

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${drive.drive_is_active ? 'bg-green-400' : 'bg-gray-300'}`} />
          <span className="text-gray-700 font-medium">{drive.drive_label}</span>
          <span className={`text-xs font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${
            drive.drive_type === 'nvme'
              ? 'bg-emerald-50 text-emerald-700'
              : 'bg-gray-100 text-gray-500'
          }`}>
            {drive.drive_type === 'nvme' ? 'Fast' : 'Standard'}
          </span>
          <span className="text-gray-400 truncate">{drive.minio_bucket}</span>
          {temp != null && (
            <span className={`font-semibold tabular-nums shrink-0 ${tempColor(temp)}`} title="Drive temperature">
              {temp.toFixed(1)}°C
            </span>
          )}
          {stat && !stat.online && (
            <span className="text-gray-400 shrink-0" title="Live mount stats unavailable — showing stored capacity. The node may be offline or the mount not visible to the API.">
              offline
            </span>
          )}
          {syncRequired && (
            <span className="text-amber-500 font-medium shrink-0" title="Re-run Sync infrastructure to detect this drive's capacity">
              ⚠ Sync required
            </span>
          )}
          {overAllocated && (
            <span className="text-red-500 font-medium shrink-0" title="Allocated quota exceeds detected drive capacity — re-run Sync infrastructure to refresh">
              ⚠ over-allocated
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-gray-400 shrink-0">
          {!syncRequired && (
            <span>
              {(usedBytes / GB).toFixed(1)} used ·{' '}
              {live && <>{(stat!.free_bytes / GB).toFixed(1)} free · </>}
              {(drive.allocated_quota_bytes / GB).toFixed(1)} allocated /{' '}
              <span className={overAllocated ? 'text-red-500' : ''}>{fmtCapacity(totalBytes)}</span>
            </span>
          )}
        </div>
      </div>
      {!syncRequired && (
        <div className="relative h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className="absolute inset-y-0 left-0 bg-blue-200 rounded-full" style={{ width: `${allocPct.toFixed(1)}%` }} />
          <div className="absolute inset-y-0 left-0 bg-blue-500 rounded-full" style={{ width: `${usedPct.toFixed(1)}%` }} />
        </div>
      )}
    </div>
  )
}

function roleBadgeClass(role: string): string {
  switch (role) {
    case 'manager': return 'bg-indigo-50 text-indigo-700'
    case 'storage': return 'bg-emerald-50 text-emerald-700'
    default:        return 'bg-gray-100 text-gray-500'
  }
}

// NodeBlock renders a single swarm node read-only: status, hostname, role
// (manager/worker), address, and its detected drives. The infrastructure sync is
// the source of truth, so there are no edit/add/remove controls.
function NodeBlock({ group, driveStats }: {
  group: NodeGroup
  driveStats: Record<string, DriveStat>
}) {
  const { node, drives } = group

  return (
    <div className="border border-gray-100 rounded-lg px-3 py-3 bg-gray-50/60">
      <div className="flex items-center gap-2 mb-2 min-w-0">
        <span className={`w-2 h-2 rounded-full shrink-0 ${node.is_active ? 'bg-green-500' : 'bg-gray-300'}`} />
        <span className="font-medium text-gray-800 text-sm truncate">{node.hostname}</span>
        <span className={`text-xs font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0 ${roleBadgeClass(node.role)}`}>{node.role}</span>
        {node.address && <span className="text-xs text-gray-400 truncate">{node.address}</span>}
        <span className="text-xs text-gray-400 shrink-0">{drives.length} drive{drives.length !== 1 ? 's' : ''}</span>
        {!node.is_active && <span className="text-xs text-gray-400 shrink-0">(inactive)</span>}
      </div>
      {drives.length === 0 ? (
        <p className="text-xs text-gray-400 m-0 pl-4">No drives detected on this node.</p>
      ) : (
        <div className="flex flex-col gap-3 pl-4">
          {drives.map((d) => (
            <DriveBar key={d.drive_id} drive={d} stat={driveStats[d.drive_id]} />
          ))}
        </div>
      )}
    </div>
  )
}
