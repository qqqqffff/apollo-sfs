import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { MdComputer, MdStorage } from 'react-icons/md'
import {
  alarmSubscriptionsQueryOptions,
  deleteAlarmSubscription,
  driveBenchmarkQueryOptions,
  driveStatsQueryOptions,
  getDriveIOHistory,
  getDriveTempsHistory,
  getMetricsHistoryByHours,
  getNodeDiskIOHistory,
  getNodeDiskTempsHistory,
  getNodeMetricsHistory,
  getTestProgress,
  infrastructureQueryOptions,
  latestTestRunQueryOptions,
  pingServer,
  renameServer,
  runTests,
  shutdownServer,
  speedTestQueryOptions,
  syncInfrastructure,
  triggerDriveBenchmark,
  triggerSpeedTest,
  upsertAlarmSubscription,
} from '../../api/admin'
import type { AlarmType, DiskFrame, DriveFrame, DriveStat, DriveSummary, LatestTestRunResponse, MetricsFrame, NodeDisk, NodeFrame, NodeSummary, TestCase, TestProgressResponse, TestRun, TestRunReport, TestSuiteEntry, TierBenchmarkStat } from '../../api/admin'
import { ApiError } from '../../api/client'
import { useMetricsStream } from '../../hooks/useMetricsStream'
import { LineGraph } from '../../components/LineGraph'
import type { LinePoint } from '../../components/LineGraph'
import { StorageDonut } from '../../components/StorageDonut'
import { AlarmConfig } from '../../components/AlarmConfig'
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

// Per-node metrics (cpu, memory, traffic, drive_temp, drive_io) graph the
// selected node; cluster metrics (users, disk, speed, ping, loss) are
// cluster-wide (manager uplink).
type MetricKey = 'total_users' | 'active_users' | 'disk' | 'memory' | 'traffic' | 'speed' | 'ping' | 'loss' | 'cpu' | 'drive_temp' | 'disk_temp' | 'drive_io' | 'disk_io'

const NODE_METRICS: ReadonlySet<MetricKey> = new Set<MetricKey>(['cpu', 'memory', 'traffic', 'drive_temp', 'disk_temp', 'drive_io', 'disk_io'])

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
  disk_temp:    'Disk temperature',
  drive_io:     'Drive speed',
  disk_io:      'Disk speed',
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
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)
  const [driveIdx, setDriveIdx] = useState(0)
  const [diskIdx, setDiskIdx] = useState(0)

  const { data: infraData } = useQuery({ ...infrastructureQueryOptions, enabled: !inactive })
  const { data: driveStatsData } = useQuery({ ...driveStatsQueryOptions, enabled: !inactive })
  const driveStats = driveStatsData?.stats ?? {}
  const nodes = infraData?.nodes ?? []
  const drives = infraData?.drives ?? []
  const physicalDisks = infraData?.disks ?? []

  // Physical disks nest under their node's logical drive in the infra tree.
  const disksByNode = new Map<string, NodeDisk[]>()
  for (const d of physicalDisks) {
    const arr = disksByNode.get(d.node_id)
    if (arr) arr.push(d)
    else disksByNode.set(d.node_id, [d])
  }

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

  // Default (and re-validate) the server dropdown to the first known server.
  useEffect(() => {
    if (servers.length === 0) return
    if (!selectedServerId || !servers.some(s => s.serverId === selectedServerId)) {
      setSelectedServerId(servers[0].serverId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers.map(s => s.serverId).join(','), selectedServerId])

  // ── Overall storage split — fast (NVMe) vs standard (HDD) capacity + allocation,
  // combined across every synced server (not scoped to the dropdown above).
  const fastDrives = drives.filter(d => d.drive_type === 'nvme')
  const standardDrives = drives.filter(d => d.drive_type === 'hdd')
  const sumBytes = (ds: DriveSummary[], key: 'capacity_bytes' | 'allocated_quota_bytes') =>
    ds.reduce((s, d) => s + d[key], 0)
  const fastTier = { capacityBytes: sumBytes(fastDrives, 'capacity_bytes'), allocatedBytes: sumBytes(fastDrives, 'allocated_quota_bytes') }
  const standardTier = { capacityBytes: sumBytes(standardDrives, 'capacity_bytes'), allocatedBytes: sumBytes(standardDrives, 'allocated_quota_bytes') }

  // ── Node selection (drives the per-node hardware + traffic cards) ──────────────
  const latestFrame = frames[frames.length - 1]
  const liveNodes: NodeFrame[] = latestFrame?.nodes ?? []
  // Live frame per node — overlays real-time disk capacity/temp/online onto the
  // infra tree's physical-disk rows.
  const liveNodeById = new Map(liveNodes.map(n => [n.node_id, n]))
  // Tabs come from registered nodes (scoped to the selected server) so a node with
  // no live data still appears; fall back to the live stream before infrastructure
  // has loaded (unscoped — NodeFrame carries no server_id).
  const nodeTabs = nodes.length
    ? nodes
        .filter(n => !selectedServerId || n.server_id === selectedServerId)
        .map(n => ({ id: n.node_id, hostname: n.hostname, role: n.role as string }))
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
  // Physical disks are reported independently of logical drives, so a pooled
  // drive's disks each surface their own capacity + temperature here.
  const nodeDisks: DiskFrame[] = selectedNode?.disks ?? []
  const safeDiskIdx = nodeDisks.length ? Math.min(diskIdx, nodeDisks.length - 1) : 0
  const selectedDisk = nodeDisks[safeDiskIdx]

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

  // ── Per-physical-disk temperature history (carousel) for the selected disk ────
  const selectedDiskId = selectedDisk?.disk_id
  const { data: diskTempHistory } = useQuery({
    queryKey: ['admin', 'disk-temps', selectedDiskId, hours],
    queryFn: () => getNodeDiskTempsHistory(selectedDiskId!, hours),
    staleTime: 60_000,
    enabled: !!selectedDiskId && hours > 1 && !inactive,
    retry: 1,
  })

  // ── Per-drive / per-physical-disk I/O history (carousel) — cumulative
  // read/write counters, diffed into a bytes/second rate below.
  const { data: driveIOHistory } = useQuery({
    queryKey: ['admin', 'drive-io', selectedDriveId, hours],
    queryFn: () => getDriveIOHistory(selectedDriveId!, hours),
    staleTime: 60_000,
    enabled: !!selectedDriveId && hours > 1 && !inactive,
    retry: 1,
  })
  const { data: diskIOHistory } = useQuery({
    queryKey: ['admin', 'disk-io', selectedDiskId, hours],
    queryFn: () => getNodeDiskIOHistory(selectedDiskId!, hours),
    staleTime: 60_000,
    enabled: !!selectedDiskId && hours > 1 && !inactive,
    retry: 1,
  })

  const { pingMs: clientPingMs, packetLossPercent: clientPacketLoss, history: clientPingHistory } = useServerPing(inactive)

  // Cluster snapshots / frames within the last hour, for live series.
  const recentSnaps = snapshots.filter(s => tMs(s.sampled_at) >= nowMs - HOUR_MS)
  const recentFrames = frames.filter(f => tMs(f.cluster.sampled_at) >= nowMs - HOUR_MS)
  const nodeIn = (f: MetricsFrame) => f.nodes?.find(n => n.node_id === selectedNodeId)

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

  // Live read/write I/O rate per physical disk / logical drive (last two
  // frames), keyed by id — the same cumulative-counter-diff approach as the
  // network traffic rate above. Backs the drive-speed carousel card.
  const ioRateByDiskId = new Map<string, { readBps: number; writeBps: number }>()
  const ioRateByDriveId = new Map<string, { readBps: number; writeBps: number }>()
  if (frames.length >= 2) {
    const prevN = nodeIn(frames[frames.length - 2]); const currN = nodeIn(frames[frames.length - 1])
    const dtMs = tMs(frames[frames.length - 1].cluster.sampled_at) - tMs(frames[frames.length - 2].cluster.sampled_at)
    if (prevN && currN && dtMs > 0) {
      const prevDiskById = new Map(prevN.disks.map(d => [d.disk_id, d]))
      for (const d of currN.disks) {
        const p = prevDiskById.get(d.disk_id)
        if (!p) continue
        ioRateByDiskId.set(d.disk_id, {
          readBps: Math.max(0, ((d.read_bytes - p.read_bytes) / dtMs) * 1000),
          writeBps: Math.max(0, ((d.write_bytes - p.write_bytes) / dtMs) * 1000),
        })
      }
      const prevDriveById = new Map(prevN.drives.map(d => [d.drive_id, d]))
      for (const d of currN.drives) {
        const p = prevDriveById.get(d.drive_id)
        if (!p) continue
        ioRateByDriveId.set(d.drive_id, {
          readBps: Math.max(0, ((d.read_bytes - p.read_bytes) / dtMs) * 1000),
          writeBps: Math.max(0, ((d.write_bytes - p.write_bytes) / dtMs) * 1000),
        })
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

  // ── Physical-disk temperature (selected node's selected disk) ──
  const wsDiskTempPoints: LinePoint[] = selectedDiskId
    ? recentFrames.flatMap(f => {
        const d = nodeIn(f)?.disks?.find(dk => dk.disk_id === selectedDiskId)
        return d && d.temp_celsius != null ? [{ x: tMs(f.cluster.sampled_at), y: d.temp_celsius }] : []
      })
    : []
  const histDiskTempPoints: LinePoint[] = (diskTempHistory ?? []).map(s => ({ x: tMs(s.sampled_at), y: s.temp_celsius }))
  const diskTempPoints = hours === 1 ? wsDiskTempPoints : histDiskTempPoints

  // ── Drive I/O (selected node's selected drive) — read+write bytes/sec,
  // derived by diffing consecutive cumulative-counter samples (live frames for
  // the 1hr view, persisted history rows otherwise), same technique as network
  // traffic above. ──
  const wsDriveIOSamples = selectedDriveId
    ? recentFrames.flatMap(f => {
        const d = nodeIn(f)?.drives.find(dr => dr.drive_id === selectedDriveId)
        return d ? [{ read_bytes: d.read_bytes, write_bytes: d.write_bytes, sampled_at: f.cluster.sampled_at }] : []
      })
    : []
  const { read: wsDriveReadPoints, write: wsDriveWritePoints } = diffIORate(wsDriveIOSamples, s => tMs(s.sampled_at))
  const { read: histDriveReadPoints, write: histDriveWritePoints } = diffIORate(driveIOHistory ?? [], s => tMs(s.sampled_at))
  const driveReadPoints = hours === 1 ? wsDriveReadPoints : histDriveReadPoints
  const driveWritePoints = hours === 1 ? wsDriveWritePoints : histDriveWritePoints

  // ── Physical-disk I/O (selected node's selected disk) ──
  const wsDiskIOSamples = selectedDiskId
    ? recentFrames.flatMap(f => {
        const d = nodeIn(f)?.disks?.find(dk => dk.disk_id === selectedDiskId)
        return d ? [{ read_bytes: d.read_bytes, write_bytes: d.write_bytes, sampled_at: f.cluster.sampled_at }] : []
      })
    : []
  const { read: wsDiskReadPoints, write: wsDiskWritePoints } = diffIORate(wsDiskIOSamples, s => tMs(s.sampled_at))
  const { read: histDiskReadPoints, write: histDiskWritePoints } = diffIORate(diskIOHistory ?? [], s => tMs(s.sampled_at))
  const diskReadPoints = hours === 1 ? wsDiskReadPoints : histDiskReadPoints
  const diskWritePoints = hours === 1 ? wsDiskWritePoints : histDiskWritePoints

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

  const [shutdownConfirm, setShutdownConfirm] = useState(false)

  const shutdownMutation = useMutation({
    mutationFn: shutdownServer,
    onError: () => notify('error', 'Shutdown request failed'),
  })

  // The cached-run query (GET /admin/system/tests/latest) is the single
  // source of truth for what the card displays — "Run tests" just writes its
  // fresh result into that same cache entry instead of keeping separate local
  // state, so a run that fails (422, still a full report) renders exactly
  // like a cached one instead of silently going nowhere.
  const { data: latestTestRun, isLoading: latestTestRunLoading } = useQuery(latestTestRunQueryOptions)

  const applyTestRun = useCallback((run: TestRun) => {
    queryClient.setQueryData<LatestTestRunResponse>(latestTestRunQueryOptions.queryKey, {
      run,
      matched_branch: true,
      current_branch: run.git_branch,
      current_version: run.deployment_version,
    })
  }, [queryClient])

  const runTestsMutation = useMutation({
    mutationFn: runTests,
    onSuccess: applyTestRun,
    onError: (err: ApiError) => {
      // A failing suite still returns the full run as the error body (422),
      // so it renders the same way a passing run would rather than vanishing.
      if (err instanceof ApiError && err.status === 422 && err.body) {
        applyTestRun(err.body as unknown as TestRun)
      } else {
        notify('error', 'Failed to run tests')
      }
    },
  })

  // The full cross-service suite can take minutes, so while a run is in
  // flight, poll the sidecar's live status instead of leaving the card on a
  // static "Running…" message — this shows which suite is currently
  // executing and the results of whichever suites have already finished.
  const { data: testProgress } = useQuery({
    queryKey: ['admin', 'tests', 'progress'],
    queryFn: getTestProgress,
    enabled: runTestsMutation.isPending,
    refetchInterval: runTestsMutation.isPending ? 3000 : false,
  })

  // Drive tier benchmark: an on-demand write/read test, not a continuous
  // sample, so it has no "…over time" graph — see the Tests section above for
  // the same request/poll shape this mirrors. benchmarkPolling is a client-side
  // safety net (stops after 90s) layered on top of the server's own `pending`
  // flag, since node-agent may take several seconds per disk to finish and
  // there's no push notification when it does — only polling.
  const [benchmarkPolling, setBenchmarkPolling] = useState(false)
  const { data: driveBenchmark, isLoading: driveBenchmarkLoading } = useQuery({
    ...driveBenchmarkQueryOptions,
    enabled: !inactive,
    refetchInterval: (query) => (benchmarkPolling || query.state.data?.pending) ? 3000 : false,
  })
  const benchmarkRunning = benchmarkPolling || !!driveBenchmark?.pending

  const triggerBenchmarkMutation = useMutation({
    mutationFn: triggerDriveBenchmark,
    onSuccess: () => {
      setBenchmarkPolling(true)
      window.setTimeout(() => setBenchmarkPolling(false), 90_000)
      queryClient.invalidateQueries({ queryKey: driveBenchmarkQueryOptions.queryKey })
    },
    onError: (err: ApiError) => {
      notify('error', err instanceof ApiError && err.status === 409 ? 'A benchmark run is already in progress' : 'Failed to start benchmark')
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
          {servers.length > 0 && (
            <select
              value={selectedServerId ?? ''}
              onChange={(e) => setSelectedServerId(e.target.value || null)}
              aria-label="Select server"
              className="text-xs border border-gray-200 rounded-md px-2 py-1 bg-white text-gray-600 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {servers.map(s => (
                <option key={s.serverId} value={s.serverId}>{s.name}</option>
              ))}
            </select>
          )}
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

      {/* ── Overall server storage — fast vs standard capacity + allocation ── */}
      <section className="mb-8">
        <h3 className="text-sm font-semibold text-gray-600 m-0 mb-3">Server storage</h3>
        <div className="bg-white border border-gray-200 rounded-xl px-6 py-4">
          <StorageDonut fast={fastTier} standard={standardTier} />
        </div>
      </section>

      {latest && (
        <>
          {/* ── Node hardware (per selected node) ─────────────────────────── */}
          <section className="mb-8">
            <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
              <h3 className="text-sm font-semibold text-gray-600 m-0">Node hardware</h3>
              <NodeTabs
                tabs={nodeTabs}
                selectedId={selectedNodeId}
                onSelect={(id) => { setSelectedNodeId(id); setDriveIdx(0); setDiskIdx(0) }}
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
              {/* Capacity + temperature come from the node's physical disks (live
                  data from the agent); a pooled logical drive never matches a
                  single disk label so its frames stay empty. Fall back to logical
                  drives only when no disks are reported (non-pooled deployments). */}
              <DriveCapacityCard items={nodeDisks.length ? nodeDisks : nodeDrives} />
              {nodeDisks.length > 0 ? (
                <DiskUsageCarousel disks={nodeDisks} index={safeDiskIdx} onIndex={setDiskIdx} />
              ) : (
                <DriveUsageCarousel drives={nodeDrives} index={safeDriveIdx} onIndex={setDriveIdx} />
              )}
              {nodeDisks.length > 0 ? (
                <DiskSpeedCarousel
                  disks={nodeDisks}
                  rates={ioRateByDiskId}
                  index={safeDiskIdx}
                  onIndex={setDiskIdx}
                  selected={selectedMetric === 'disk_io'}
                  onClick={() => setSelectedMetric('disk_io')}
                />
              ) : (
                <DriveSpeedCarousel
                  drives={nodeDrives}
                  rates={ioRateByDriveId}
                  index={safeDriveIdx}
                  onIndex={setDriveIdx}
                  selected={selectedMetric === 'drive_io'}
                  onClick={() => setSelectedMetric('drive_io')}
                />
              )}
              {nodeDisks.length > 0 ? (
                <DiskTempCarousel
                  disks={nodeDisks}
                  index={safeDiskIdx}
                  onIndex={setDiskIdx}
                  selected={selectedMetric === 'disk_temp'}
                  onClick={() => setSelectedMetric('disk_temp')}
                />
              ) : (
                <DriveTempCarousel
                  drives={nodeDrives}
                  index={safeDriveIdx}
                  onIndex={setDriveIdx}
                  selected={selectedMetric === 'drive_temp'}
                  onClick={() => setSelectedMetric('drive_temp')}
                />
              )}
            </div>
            {nodeDisks.length > 0 && (
              <div className="mt-3">
                <PhysicalDisksCard
                  disks={nodeDisks}
                  selectedIdx={safeDiskIdx}
                  onSelect={(i) => { setDiskIdx(i); setSelectedMetric('disk_temp') }}
                />
              </div>
            )}
          </section>

          {/* ── Server network (traffic per node, uplink shared) ──────────── */}
          <section className="mb-8">
            <h3 className="text-sm font-semibold text-gray-600 m-0 mb-3">Server network</h3>
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
            {selectedMetric === 'disk_temp' && selectedDisk ? ` · ${selectedDisk.label}` : ''}
            {selectedMetric === 'drive_io' && selectedDrive ? ` · ${selectedDrive.label}` : ''}
            {selectedMetric === 'disk_io' && selectedDisk ? ` · ${selectedDisk.label}` : ''}
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
          {selectedMetric === 'disk_temp' && (
            <LineGraph points={diskTempPoints} width={graphW} height={200} color="#06b6d4" formatY={formatTempY} formatX={formatGraphX} />
          )}
          {selectedMetric === 'drive_io' && (
            <div className="flex flex-col gap-4">
              <div>
                <div className="text-xs text-gray-400 mb-2">↓ Read</div>
                <LineGraph points={driveReadPoints} width={graphW} height={160} color="#10b981" formatY={formatBytesPerSec} formatX={formatGraphX} />
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-2">↑ Write</div>
                <LineGraph points={driveWritePoints} width={graphW} height={160} color="#3b82f6" formatY={formatBytesPerSec} formatX={formatGraphX} />
              </div>
            </div>
          )}
          {selectedMetric === 'disk_io' && (
            <div className="flex flex-col gap-4">
              <div>
                <div className="text-xs text-gray-400 mb-2">↓ Read</div>
                <LineGraph points={diskReadPoints} width={graphW} height={160} color="#10b981" formatY={formatBytesPerSec} formatX={formatGraphX} />
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-2">↑ Write</div>
                <LineGraph points={diskWritePoints} width={graphW} height={160} color="#3b82f6" formatY={formatBytesPerSec} formatX={formatGraphX} />
              </div>
            </div>
          )}
        </div>
      </section>

      <MetricAlarms
        selectedMetric={selectedMetric}
        nodeId={selectedNodeId}
        nodeLabel={(() => {
          const t = nodeTabs.find(tab => tab.id === selectedNodeId)
          return t ? `${t.hostname}${t.role ? ` · ${t.role}` : ''}` : ''
        })()}
        driveId={selectedDrive?.drive_id ?? null}
        driveLabel={selectedDrive?.label ?? ''}
      />

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
          {latestTestRunLoading && !runTestsMutation.isPending && (
            <p className="text-sm text-gray-400 m-0">Loading…</p>
          )}
          {runTestsMutation.isPending && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-gray-400 m-0 animate-pulse">Running test suites…</p>
              <TestProgressList progress={testProgress} />
            </div>
          )}
          {!latestTestRunLoading && !runTestsMutation.isPending && (!latestTestRun || !latestTestRun.run) && (
            <p className="text-sm text-gray-400 m-0">None — no test run has been recorded yet. Click "Run tests" to execute the suite.</p>
          )}
          {!runTestsMutation.isPending && latestTestRun?.run && (
            <TestRunPanel latest={latestTestRun} />
          )}
        </div>
      </section>

      <section className="mb-10">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-600 m-0">Drive benchmark</h3>
          <button
            onClick={() => triggerBenchmarkMutation.mutate()}
            disabled={triggerBenchmarkMutation.isPending || benchmarkRunning}
            className="text-xs bg-blue-600 text-white rounded px-2 py-1 disabled:opacity-50 cursor-pointer"
            title="Write and read a test file on every fast-tier NVMe drive and the standard-tier HDD, then compare them"
          >
            {benchmarkRunning ? 'Running…' : 'Run benchmark'}
          </button>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
          {driveBenchmarkLoading && !benchmarkRunning && (
            <p className="text-sm text-gray-400 m-0">Loading…</p>
          )}
          {benchmarkRunning && (
            <BenchmarkProgress completed={driveBenchmark?.completed_nodes ?? 0} total={driveBenchmark?.total_nodes ?? 0} />
          )}
          {!driveBenchmarkLoading && !benchmarkRunning && !driveBenchmark?.fast && !driveBenchmark?.standard && (
            <p className="text-sm text-gray-400 m-0">None — no benchmark has been run yet. Click "Run benchmark" to test both tiers.</p>
          )}
          {!benchmarkRunning && (driveBenchmark?.fast || driveBenchmark?.standard) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TierBenchmarkCard label="Fast (NVMe)" stat={driveBenchmark?.fast} />
              <TierBenchmarkCard label="Standard (HDD)" stat={driveBenchmark?.standard} />
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
                  <ServerNameEditor serverId={srv.serverId} name={srv.name} />
                  {!srv.isActive && <span className="text-xs text-gray-400">(inactive)</span>}
                </div>
                <div className="flex flex-col gap-3">
                  {srv.nodes.length === 0 && srv.unassigned.length === 0 && (
                    <p className="text-xs text-gray-400 m-0">No nodes detected on this server.</p>
                  )}
                  {srv.nodes.map((ng) => (
                    <NodeBlock
                      key={ng.node.node_id}
                      group={ng}
                      driveStats={driveStats}
                      disks={disksByNode.get(ng.node.node_id) ?? []}
                      liveNode={liveNodeById.get(ng.node.node_id)}
                    />
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

// MetricAlarms renders the alarm controls contextual to the current metric +
// node/drive selection, plus a persistent cluster-wide API error-rate alarm.
// Subscriptions belong to the signed-in admin (emailed to them when breached).
function MetricAlarms({ selectedMetric, nodeId, nodeLabel, driveId, driveLabel }: {
  selectedMetric: MetricKey
  nodeId: string | null
  nodeLabel: string
  driveId: string | null
  driveLabel: string
}) {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const { data: subs } = useQuery(alarmSubscriptionsQueryOptions())

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['admin', 'alarm', 'subscriptions', 'self'] })
  const upsertMut = useMutation({
    mutationFn: upsertAlarmSubscription,
    onSuccess: invalidate,
    onError: () => notify('error', 'Failed to update alarm'),
  })
  const removeMut = useMutation({
    mutationFn: deleteAlarmSubscription,
    onSuccess: invalidate,
    onError: () => notify('error', 'Failed to update alarm'),
  })
  const pending = upsertMut.isPending || removeMut.isPending

  const find = (type: AlarmType, nId: string | null, dId: string | null) =>
    subs?.find(s => s.alarm_type === type && (s.node_id ?? null) === nId && (s.drive_id ?? null) === dId)

  type Row = { type: AlarmType; label: string; description: string }
  let rows: Row[] = []
  let scopeNodeId: string | null = null
  let scopeDriveId: string | null = null
  let targetLabel = ''

  if (selectedMetric === 'cpu' && nodeId) {
    rows = [
      { type: 'cpu_usage', label: 'High CPU usage', description: 'Average CPU over 30 min exceeds the threshold.' },
      { type: 'cpu_temp', label: 'High CPU temperature', description: 'Average CPU temperature over 30 min exceeds the threshold.' },
    ]
    scopeNodeId = nodeId; targetLabel = nodeLabel
  } else if (selectedMetric === 'memory' && nodeId) {
    rows = [{ type: 'memory', label: 'High memory usage', description: 'Average memory over 30 min exceeds the threshold.' }]
    scopeNodeId = nodeId; targetLabel = nodeLabel
  } else if (selectedMetric === 'traffic' && nodeId) {
    rows = [{ type: 'network_traffic', label: 'High network traffic', description: 'Average throughput over 30 min exceeds the % of the last speed test.' }]
    scopeNodeId = nodeId; targetLabel = nodeLabel
  } else if (selectedMetric === 'drive_temp' && driveId) {
    rows = [
      { type: 'drive_temp', label: 'High drive temperature', description: 'Average drive temperature over 30 min exceeds the threshold.' },
      { type: 'drive_load', label: 'High drive load', description: 'Allocated capacity exceeds the threshold.' },
    ]
    scopeDriveId = driveId; targetLabel = driveLabel
  }

  return (
    <section className="mb-10">
      <div className="flex items-center gap-3 mb-3">
        <h3 className="text-sm font-semibold text-gray-600 m-0">Alarms</h3>
        <span className="text-xs text-gray-400">emailed to you · 30-min sustained · 1-hr cooldown</span>
      </div>
      <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        {rows.length === 0 && (
          <p className="px-5 py-4 text-sm text-gray-400 m-0">
            No node/drive alarms apply to this metric. Select CPU, Memory, Network traffic, or Drive temperature to configure them.
          </p>
        )}
        {rows.map(r => (
          <AlarmConfig
            key={r.type}
            alarmType={r.type}
            label={r.label}
            description={r.description}
            targetLabel={targetLabel}
            subscription={find(r.type, scopeNodeId, scopeDriveId)}
            pending={pending}
            onUpsert={(threshold) => upsertMut.mutate({
              alarm_type: r.type,
              node_id: scopeNodeId ?? undefined,
              drive_id: scopeDriveId ?? undefined,
              threshold,
            })}
            onRemove={() => removeMut.mutate({
              alarm_type: r.type,
              node_id: scopeNodeId ?? undefined,
              drive_id: scopeDriveId ?? undefined,
            })}
          />
        ))}
        <AlarmConfig
          alarmType="api_error_rate"
          label="Elevated API error rate"
          description="Cluster-wide: percentage of API requests returning a server error over 30 min."
          targetLabel="Cluster"
          subscription={find('api_error_rate', null, null)}
          pending={pending}
          onUpsert={(threshold) => upsertMut.mutate({ alarm_type: 'api_error_rate', threshold })}
          onRemove={() => removeMut.mutate({ alarm_type: 'api_error_rate' })}
        />
      </div>
    </section>
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

import type { SpeedTestResult } from '../../api/admin'

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

// ── Drive benchmark progress ─────────────────────────────────────────────────
// Determinate progress: a node's whole disk batch (sequential + random pass,
// every configured disk) arrives in one atomic push (see
// docs/drive_benchmark_setup.md), so completed/total nodes is the finest real
// progress signal the server can offer — usually just 0/2 → 1/2 → 2/2 for the
// manager + Pi 5 topology, but it's honest rather than a fake timer-based fill.
function BenchmarkProgress({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (completed / total) * 100) : 0
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-sm text-gray-400 m-0 animate-pulse">Benchmarking fast and standard tier drives…</p>
        {total > 0 && (
          <span className="text-xs text-gray-400 tabular-nums shrink-0 ml-3">{completed}/{total} nodes</span>
        )}
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full bg-blue-500 transition-all duration-500 ${completed < total ? 'animate-pulse' : ''}`}
          style={{ width: `${Math.max(pct, 6)}%` }}
        />
      </div>
    </div>
  )
}

// ── Drive benchmark card ─────────────────────────────────────────────────────
// One tier's averaged sequential + random-access result — no history to graph
// (see the Tests section above for the shape this on-demand result mirrors),
// just the most recent run.

function TierBenchmarkCard({ label, stat }: { label: string; stat: TierBenchmarkStat | undefined }) {
  if (!stat) {
    return (
      <div className="border border-dashed border-gray-200 rounded-lg px-4 py-3">
        <p className="text-xs font-semibold text-gray-500 m-0 mb-1">{label}</p>
        <p className="text-xs text-gray-400 m-0">No successful result yet</p>
      </div>
    )
  }
  return (
    <div className="border border-gray-200 rounded-lg px-4 py-3">
      <p className="text-xs font-semibold text-gray-500 m-0 mb-1">{label}</p>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 m-0 mb-0.5">Sequential</p>
      <p className="text-lg font-bold text-gray-900 tabular-nums m-0">
        {stat.seq_write_mbps.toFixed(0)} <span className="text-xs font-normal text-gray-400">MB/s write</span>
      </p>
      <p className="text-lg font-bold text-gray-900 tabular-nums m-0">
        {stat.seq_read_mbps.toFixed(0)} <span className="text-xs font-normal text-gray-400">MB/s read</span>
      </p>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 m-0 mt-2 mb-0.5">Random (4K)</p>
      <p className="text-sm font-bold text-gray-900 tabular-nums m-0">
        {stat.random_write_iops.toFixed(0)} <span className="text-xs font-normal text-gray-400">IOPS write · {stat.random_write_mbps.toFixed(1)} MB/s</span>
      </p>
      <p className="text-sm font-bold text-gray-900 tabular-nums m-0">
        {stat.random_read_iops.toFixed(0)} <span className="text-xs font-normal text-gray-400">IOPS read · {stat.random_read_mbps.toFixed(1)} MB/s</span>
      </p>
      <p className="text-[11px] text-gray-400 m-0 mt-2">
        {stat.disk_count} disk{stat.disk_count === 1 ? '' : 's'} · {new Date(stat.tested_at).toLocaleString()}
      </p>
    </div>
  )
}

// ── Test-runner card ─────────────────────────────────────────────────────────
// Groups the five suites the sidecar reports into four application areas:
// Frontend (unit + E2E), API (backend), Recognition, and Mobile.

type SuiteKey = 'backend' | 'frontend' | 'frontend_e2e' | 'mobile' | 'recognition'

interface TestGroupDef {
  key: string
  label: string
  suites: { key: SuiteKey; label: string }[]
}

const TEST_GROUPS: TestGroupDef[] = [
  { key: 'frontend', label: 'Frontend', suites: [{ key: 'frontend', label: 'Unit' }, { key: 'frontend_e2e', label: 'E2E' }] },
  { key: 'api', label: 'API', suites: [{ key: 'backend', label: 'Backend' }] },
  { key: 'recognition', label: 'Recognition', suites: [{ key: 'recognition', label: 'Recognition' }] },
  { key: 'mobile', label: 'Mobile', suites: [{ key: 'mobile', label: 'Mobile' }] },
]

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000))
}

// A suite with no discrete test count (e.g. the backend local-exec fallback,
// which has no structured parser) still counts as one pass/fail unit so the
// percentage bar always has something to show.
function suiteUnits(entry: TestSuiteEntry): { total: number; passed: number } {
  const result = entry.result
  if (!result) return { total: 0, passed: 0 }
  if (result.num_tests > 0) return { total: result.num_tests, passed: result.num_passed }
  return { total: 1, passed: result.passed ? 1 : 0 }
}

const SUITE_LABELS: Record<SuiteKey, string> = {
  backend: 'Backend (API)',
  frontend: 'Frontend (unit)',
  frontend_e2e: 'Frontend (E2E)',
  mobile: 'Mobile',
  recognition: 'Recognition',
}

// Live status of a single suite while a run is in flight — derived from
// TestProgressResponse (see GET /admin/system/tests/progress): 'done' suites
// render their pass/fail exactly like a finished run would.
type SuiteProgressStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped'

function suiteProgressStatus(key: string, progress: TestProgressResponse | undefined): SuiteProgressStatus {
  const entry = progress?.completed?.[key]
  if (entry) {
    if (!entry.enabled) return 'skipped'
    return entry.result && entry.result.passed === false ? 'failed' : 'passed'
  }
  if (progress?.current_suite === key) return 'running'
  return 'pending'
}

// Shown while runTestsMutation.isPending, polling GET /admin/system/tests/progress
// (every 3s — see the useQuery above) so the card reflects which suite is
// currently running and the results of whichever have already finished,
// instead of a single static "Running…" message for the whole multi-minute run.
function TestProgressList({ progress }: { progress: TestProgressResponse | undefined }) {
  const order = progress?.order ?? ['backend', 'frontend', 'frontend_e2e', 'mobile', 'recognition']
  return (
    <ul className="flex flex-col gap-1 pl-0 list-none">
      {order.map((key) => {
        const status = suiteProgressStatus(key, progress)
        const entry = progress?.completed?.[key]
        return (
          <li key={key} className="flex items-center gap-2 text-xs">
            {status === 'running' ? (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0 animate-pulse" />
            ) : (
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                status === 'passed' ? 'bg-green-500' :
                status === 'failed' ? 'bg-red-500' :
                status === 'skipped' ? 'bg-gray-300' : 'bg-gray-200'
              }`} />
            )}
            <span className={status === 'pending' ? 'text-gray-400' : 'text-gray-600'}>
              {SUITE_LABELS[key as SuiteKey] ?? key}
            </span>
            <span className="text-gray-400">
              {status === 'running' && 'running…'}
              {status === 'passed' && entry?.result && `passed · ${formatDurationMs(entry.result.duration_ms)}`}
              {status === 'failed' && entry?.result && `failed · ${formatDurationMs(entry.result.duration_ms)}`}
              {status === 'skipped' && 'skipped'}
              {status === 'pending' && 'pending'}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function TestRunPanel({ latest }: { latest: LatestTestRunResponse }) {
  const run = latest.run
  if (!run) return null
  const stale = daysSince(run.created_at) > 30

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 text-xs text-gray-500">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Branch <span className="font-medium text-gray-700">{run.git_branch || 'unknown'}</span></span>
          <span>Version <span className="font-mono text-gray-700">{run.deployment_version || 'unknown'}</span></span>
          <span>Ran {new Date(run.created_at).toLocaleString()}</span>
        </div>
        {!latest.matched_branch && (
          <div className="text-amber-600">
            No test run yet for the current branch ("{latest.current_branch || 'unknown'}") — showing the most recent run, from branch "{run.git_branch || 'unknown'}" (version {run.deployment_version || 'unknown'}).
          </div>
        )}
        {stale && (
          <div className="text-amber-600">
            Last run was {daysSince(run.created_at)} days ago — results may be out of date.
          </div>
        )}
      </div>
      <div className="flex flex-col gap-3">
        {TEST_GROUPS.map((group) => (
          <TestGroupCard key={group.key} group={group} report={run.report} />
        ))}
      </div>
    </div>
  )
}

function TestGroupCard({ group, report }: { group: TestGroupDef; report: TestRunReport }) {
  const [expanded, setExpanded] = useState(false)
  const entries = group.suites.map((s) => ({ ...s, entry: report[s.key] }))
  const enabledEntries = entries.filter((e) => e.entry.enabled)

  if (enabledEntries.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <span className="w-2 h-2 rounded-full bg-gray-200 shrink-0" />
        <span className="font-medium text-gray-500">{group.label}</span>
        <span className="text-xs">{entries[0]?.entry.message ?? 'disabled'}</span>
      </div>
    )
  }

  let total = 0
  let passed = 0
  let durationMs = 0
  const linesSamples: number[] = []
  const branchesSamples: number[] = []
  for (const e of enabledEntries) {
    const units = suiteUnits(e.entry)
    total += units.total
    passed += units.passed
    durationMs += e.entry.result?.duration_ms ?? 0
    const cov = e.entry.result?.coverage
    if (cov?.lines_pct != null) linesSamples.push(cov.lines_pct)
    if (cov?.branches_pct != null) branchesSamples.push(cov.branches_pct)
  }
  const pct = total > 0 ? (passed / total) * 100 : null
  const linesPct = average(linesSamples)
  const branchesPct = average(branchesSamples)

  return (
    <div className="border border-gray-100 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-gray-700 text-sm">{group.label}</span>
          <span className="text-xs text-gray-400">{passed}/{total} tests · {formatDurationMs(durationMs)}</span>
        </div>
        <button
          onClick={() => setExpanded((x) => !x)}
          className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 shrink-0"
        >
          {expanded ? '▲ hide details' : '▼ details'}
        </button>
      </div>
      <PercentBar pct={pct} />
      {(linesPct != null || branchesPct != null) && (
        <div className="flex gap-4 mt-2 text-xs text-gray-500">
          {linesPct != null && <span>Lines: {linesPct.toFixed(1)}%</span>}
          {branchesPct != null && <span>Branches: {branchesPct.toFixed(1)}%</span>}
        </div>
      )}
      {expanded && (
        <div className="mt-3 flex flex-col gap-3">
          {enabledEntries.map((e) => (
            <SuiteDetail key={e.key} label={e.label} entry={e.entry} />
          ))}
        </div>
      )}
    </div>
  )
}

function PercentBar({ pct }: { pct: number | null }) {
  if (pct == null) {
    return <div className="h-2 rounded-full bg-gray-100" />
  }
  const color = pct >= 100 ? 'bg-green-500' : pct >= 50 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
      <div className={`h-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  )
}

function SuiteDetail({ label, entry }: { label: string; entry: TestSuiteEntry }) {
  const [showOutput, setShowOutput] = useState(false)
  const result = entry.result
  if (!result) return null

  return (
    <div>
      <div className="flex items-center gap-2 text-xs mb-1.5 flex-wrap">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${result.passed ? 'bg-green-500' : 'bg-red-500'}`} />
        <span className="font-medium text-gray-600">{label}</span>
        <span className={`font-medium ${result.passed ? 'text-green-600' : 'text-red-600'}`}>
          {result.passed ? 'PASS' : 'FAIL'}
        </span>
        {result.num_tests > 0 && (
          <span className="text-gray-400">{result.num_passed}/{result.num_tests} tests</span>
        )}
        <span className="text-gray-400">{formatDurationMs(result.duration_ms)}</span>
      </div>
      {result.tests && result.tests.length > 0 && (
        <ul className="flex flex-col gap-0.5 mb-1.5 max-h-52 overflow-y-auto pl-0 list-none">
          {result.tests.map((t, i) => (
            <TestCaseRow key={`${t.name}-${i}`} test={t} />
          ))}
        </ul>
      )}
      <button
        onClick={() => setShowOutput((o) => !o)}
        className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 text-left w-fit"
      >
        {showOutput ? '▲ hide raw output' : '▼ raw output'}
      </button>
      {showOutput && <OutputBlock label={label} output={result.output} />}
    </div>
  )
}

function TestCaseRow({ test }: { test: TestCase }) {
  const [open, setOpen] = useState(false)
  const hasMessage = !!test.message
  return (
    <li className="text-xs">
      <button
        onClick={() => hasMessage && setOpen((o) => !o)}
        className={`flex items-center gap-1.5 w-full text-left bg-transparent border-0 p-0 ${hasMessage ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${test.passed ? 'bg-green-500' : 'bg-red-500'}`} />
        <span className={`truncate ${test.passed ? 'text-gray-600' : 'text-red-700'}`}>{test.name}</span>
        {test.duration_ms != null && <span className="text-gray-400 shrink-0 ml-auto">{test.duration_ms} ms</span>}
      </button>
      {open && hasMessage && (
        <pre className="mt-1 ml-3 bg-red-50 border border-red-100 rounded p-2 text-[11px] text-red-700 whitespace-pre-wrap overflow-x-auto max-h-40 overflow-y-auto">
          {test.message}
        </pre>
      )}
    </li>
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

// roleBadgeIcon differentiates managers (compute/control-plane node) from workers
// (storage-only node, e.g. the fast-tier Pi) in the node selector.
function roleBadgeIcon(role: string) {
  return role === 'manager' ? <MdComputer aria-hidden /> : <MdStorage aria-hidden />
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
          className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border cursor-pointer transition-colors ${
            t.id === selectedId
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
          }`}
        >
          {roleBadgeIcon(t.role)}
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
// DriveCapacityCard aggregates the node's storage capacity. It accepts physical
// disks (live agent data, preferred) or logical drive frames — both expose
// total_bytes/used_bytes — so a pooled drive reports the real disk totals.
function DriveCapacityCard({ items }: { items: { total_bytes: number; used_bytes: number }[] }) {
  const total = items.reduce((s, d) => s + d.total_bytes, 0)
  const used = items.reduce((s, d) => s + d.used_bytes, 0)
  const pct = total > 0 ? (used / total) * 100 : 0
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
      <div className="text-xs text-gray-400 mb-1">Drive capacity</div>
      {items.length === 0 ? (
        <div className="text-sm font-semibold text-gray-400">no live data</div>
      ) : (
        <>
          <div className="text-xl font-semibold text-gray-900">{fmtCapacity(used)}</div>
          <div className="text-xs text-gray-400 mt-0.5">
            {pct.toFixed(1)}% of {fmtCapacity(total)} · {items.length} disk{items.length !== 1 ? 's' : ''}
          </div>
        </>
      )}
    </div>
  )
}

// DiskUsageCarousel pages through the selected node's physical disks, one
// usage bar per slide — a per-disk complement to DriveCapacityCard's node-wide
// aggregate. Shares its index with DiskTempCarousel so paging either one keeps
// both showing the same disk.
function DiskUsageCarousel({ disks, index, onIndex }: {
  disks: DiskFrame[]
  index: number
  onIndex: (i: number) => void
}) {
  const has = disks.length > 0
  const d = has ? disks[Math.min(index, disks.length - 1)] : undefined
  const pct = d && d.total_bytes > 0 ? (d.used_bytes / d.total_bytes) * 100 : 0
  const step = (delta: number, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!has) return
    onIndex((index + delta + disks.length) % disks.length)
  }
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-gray-400">Disk usage</div>
        {disks.length > 1 && (
          <div className="flex items-center gap-1">
            <button onClick={(e) => step(-1, e)} className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 px-1" title="Previous disk usage">‹</button>
            <span className="text-xs text-gray-400 tabular-nums">{index + 1}/{disks.length}</span>
            <button onClick={(e) => step(1, e)} className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 px-1" title="Next disk usage">›</button>
          </div>
        )}
      </div>
      {d ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-600 font-medium truncate" title={d.device || d.label}>{d.label}</span>
            <span className="text-lg font-semibold tabular-nums shrink-0 text-gray-900">{pct.toFixed(1)}%</span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded-full mt-1.5 overflow-hidden">
            <div className={`h-full rounded-full ${pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
          <div className="text-xs text-gray-400 mt-0.5">{fmtCapacity(d.used_bytes)} / {fmtCapacity(d.total_bytes)}</div>
        </>
      ) : (
        <div className="text-sm font-semibold text-gray-400">no live data</div>
      )}
    </div>
  )
}

// DriveUsageCarousel is DiskUsageCarousel's fallback for non-pooled deployments
// with no physical-disk reporting — pages through logical drives instead.
function DriveUsageCarousel({ drives, index, onIndex }: {
  drives: DriveFrame[]
  index: number
  onIndex: (i: number) => void
}) {
  const has = drives.length > 0
  const d = has ? drives[Math.min(index, drives.length - 1)] : undefined
  const pct = d && d.total_bytes > 0 ? (d.used_bytes / d.total_bytes) * 100 : 0
  const step = (delta: number, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!has) return
    onIndex((index + delta + drives.length) % drives.length)
  }
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-gray-400">Disk usage</div>
        {drives.length > 1 && (
          <div className="flex items-center gap-1">
            <button onClick={(e) => step(-1, e)} className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 px-1" title="Previous drive usage">‹</button>
            <span className="text-xs text-gray-400 tabular-nums">{index + 1}/{drives.length}</span>
            <button onClick={(e) => step(1, e)} className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 px-1" title="Next drive usage">›</button>
          </div>
        )}
      </div>
      {d ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-600 font-medium truncate" title={d.label}>{d.label}</span>
            <span className="text-lg font-semibold tabular-nums shrink-0 text-gray-900">{pct.toFixed(1)}%</span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded-full mt-1.5 overflow-hidden">
            <div className={`h-full rounded-full ${pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
          <div className="text-xs text-gray-400 mt-0.5">{fmtCapacity(d.used_bytes)} / {fmtCapacity(d.total_bytes)} · {d.drive_type === 'nvme' ? 'Fast' : 'Standard'}</div>
        </>
      ) : (
        <div className="text-sm font-semibold text-gray-400">no live data</div>
      )}
    </div>
  )
}

// DiskSpeedCarousel pages through the selected node's physical disks, one
// read+write throughput reading per slide — the live rate comes from
// ioRateByDiskId (derived by the page from consecutive live frames, the same
// way network traffic rate is computed); clicking it (like DiskTempCarousel)
// selects the "over time" graph below, backed by node_disk_io_snapshots
// history. Shares its index with DiskUsageCarousel/DiskTempCarousel so paging
// any one keeps them in sync.
function DiskSpeedCarousel({ disks, rates, index, onIndex, selected, onClick }: {
  disks: DiskFrame[]
  rates: Map<string, { readBps: number; writeBps: number }>
  index: number
  onIndex: (i: number) => void
  selected?: boolean
  onClick?: () => void
}) {
  const has = disks.length > 0
  const d = has ? disks[Math.min(index, disks.length - 1)] : undefined
  const pct = d && d.total_bytes > 0 ? (d.used_bytes / d.total_bytes) * 100 : 0
  const rate = d ? rates.get(d.disk_id) : undefined
  const bps = rate ? rate.readBps + rate.writeBps : null
  const step = (delta: number, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!has) return
    onIndex((index + delta + disks.length) % disks.length)
  }
  return (
    <div
      className={`bg-white border rounded-xl px-4 py-3 cursor-pointer transition-colors ${selected ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-gray-400">Disk speed</div>
        {disks.length > 1 && (
          <div className="flex items-center gap-1">
            <button onClick={(e) => step(-1, e)} className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 px-1" title="Previous disk speed">‹</button>
            <span className="text-xs text-gray-400 tabular-nums">{index + 1}/{disks.length}</span>
            <button onClick={(e) => step(1, e)} className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 px-1" title="Next disk speed">›</button>
          </div>
        )}
      </div>
      {d ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-600 font-medium truncate" title={d.device || d.label}>{d.label}</span>
            <span className="text-lg font-semibold tabular-nums shrink-0 text-gray-900">{bps != null ? formatBytesPerSec(bps) : '—'}</span>
          </div>
          <div className="text-xs text-gray-400 mt-0.5">{pct.toFixed(1)}% used</div>
        </>
      ) : (
        <div className="text-sm font-semibold text-gray-400">no live data</div>
      )}
    </div>
  )
}

// DriveSpeedCarousel is DiskSpeedCarousel's fallback for non-pooled deployments
// with no physical-disk reporting — pages through logical drives instead.
function DriveSpeedCarousel({ drives, rates, index, onIndex, selected, onClick }: {
  drives: DriveFrame[]
  rates: Map<string, { readBps: number; writeBps: number }>
  index: number
  onIndex: (i: number) => void
  selected?: boolean
  onClick?: () => void
}) {
  const has = drives.length > 0
  const d = has ? drives[Math.min(index, drives.length - 1)] : undefined
  const pct = d && d.total_bytes > 0 ? (d.used_bytes / d.total_bytes) * 100 : 0
  const rate = d ? rates.get(d.drive_id) : undefined
  const bps = rate ? rate.readBps + rate.writeBps : null
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
        <div className="text-xs text-gray-400">Drive speed</div>
        {drives.length > 1 && (
          <div className="flex items-center gap-1">
            <button onClick={(e) => step(-1, e)} className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 px-1" title="Previous drive speed">‹</button>
            <span className="text-xs text-gray-400 tabular-nums">{index + 1}/{drives.length}</span>
            <button onClick={(e) => step(1, e)} className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 px-1" title="Next drive speed">›</button>
          </div>
        )}
      </div>
      {d ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-600 font-medium truncate" title={d.label}>{d.label}</span>
            <span className="text-lg font-semibold tabular-nums shrink-0 text-gray-900">{bps != null ? formatBytesPerSec(bps) : '—'}</span>
          </div>
          <div className="text-xs text-gray-400 mt-0.5">{pct.toFixed(1)}% used</div>
        </>
      ) : (
        <div className="text-sm font-semibold text-gray-400">no live data</div>
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

// DiskTempCarousel pages through the selected node's physical disks, one
// temperature per slide — independent of logical drives, so each disk in a pool
// is visible on its own.
function DiskTempCarousel({ disks, index, onIndex, selected, onClick }: {
  disks: DiskFrame[]
  index: number
  onIndex: (i: number) => void
  selected?: boolean
  onClick?: () => void
}) {
  const has = disks.length > 0
  const d = has ? disks[Math.min(index, disks.length - 1)] : undefined
  const step = (delta: number, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!has) return
    onIndex((index + delta + disks.length) % disks.length)
  }
  return (
    <div
      className={`bg-white border rounded-xl px-4 py-3 cursor-pointer transition-colors ${selected ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-gray-400">Disk temp</div>
        {disks.length > 1 && (
          <div className="flex items-center gap-1">
            <button onClick={(e) => step(-1, e)} className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 px-1" title="Previous disk">‹</button>
            <span className="text-xs text-gray-400 tabular-nums">{index + 1}/{disks.length}</span>
            <button onClick={(e) => step(1, e)} className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 px-1" title="Next disk">›</button>
          </div>
        )}
      </div>
      {d ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-600 font-medium truncate" title={d.device || d.label}>{d.label}</span>
            <span className={`text-lg font-semibold tabular-nums shrink-0 ${d.temp_celsius != null ? tempColor(d.temp_celsius) : 'text-gray-400'}`}>
              {d.temp_celsius != null ? `${d.temp_celsius.toFixed(1)}°C` : '—'}
            </span>
          </div>
          <div className="text-xs text-gray-400 mt-0.5 truncate">{d.device || 'physical disk'}</div>
        </>
      ) : (
        <div className="text-sm font-semibold text-gray-400">no live data</div>
      )}
    </div>
  )
}

// PhysicalDisksCard lists every physical disk a node reports, each with its own
// fill bar + temperature. With a pooled drive this is where divergence shows up:
// one disk filling or running hotter than the others in the same pool.
function PhysicalDisksCard({ disks, selectedIdx, onSelect }: {
  disks: DiskFrame[]
  selectedIdx: number
  onSelect: (i: number) => void
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
      <div className="text-xs text-gray-400 mb-2">Physical disks · {disks.length}</div>
      <div className="flex flex-col gap-2">
        {disks.map((d, i) => {
          const pct = d.total_bytes > 0 ? (d.used_bytes / d.total_bytes) * 100 : 0
          return (
            <button
              key={d.disk_id}
              onClick={() => onSelect(i)}
              className={`w-full text-left bg-transparent border rounded-lg px-3 py-2 cursor-pointer transition-colors ${i === selectedIdx ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-100 hover:border-gray-300'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-gray-800 truncate" title={d.device || d.label}>{d.label}</span>
                <span className={`text-sm font-semibold tabular-nums shrink-0 ${d.temp_celsius != null ? tempColor(d.temp_celsius) : 'text-gray-400'}`}>
                  {d.temp_celsius != null ? `${d.temp_celsius.toFixed(1)}°C` : '—'}
                </span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full mt-1.5 overflow-hidden">
                <div className={`h-full rounded-full ${pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(pct, 100)}%` }} />
              </div>
              <div className="text-xs text-gray-400 mt-0.5">
                {fmtCapacity(d.used_bytes)} / {fmtCapacity(d.total_bytes)} · {pct.toFixed(1)}%
              </div>
            </button>
          )
        })}
      </div>
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

// diffIORate turns a time-ordered series of cumulative (read_bytes,
// write_bytes) samples into read/write bytes-per-second point series — the
// same cumulative-counter-diff technique used for network traffic, applied
// here to both live WS frames and persisted history rows. Pairs with a
// non-positive time delta or a counter reset (negative rate) are dropped.
function diffIORate<T extends { read_bytes: number; write_bytes: number }>(
  samples: T[],
  tsOf: (s: T) => number,
): { read: LinePoint[]; write: LinePoint[] } {
  const read: LinePoint[] = []
  const write: LinePoint[] = []
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]; const curr = samples[i]
    const dtMs = tsOf(curr) - tsOf(prev)
    if (dtMs <= 0) continue
    const readBps = ((curr.read_bytes - prev.read_bytes) / dtMs) * 1000
    const writeBps = ((curr.write_bytes - prev.write_bytes) / dtMs) * 1000
    if (readBps < 0 || writeBps < 0) continue
    read.push({ x: tsOf(curr), y: readBps })
    write.push({ x: tsOf(curr), y: writeBps })
  }
  return { read, write }
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

// ServerNameEditor shows the cluster server's name with an inline pencil that
// swaps it for an input. Saving calls the existing rename endpoint and refreshes
// the infrastructure tree.
function ServerNameEditor({ serverId, name }: { serverId: string; name: string }) {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)

  useEffect(() => { setValue(name) }, [name])

  const mutation = useMutation({
    mutationFn: (newName: string) => renameServer(serverId, newName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'infrastructure'] })
      setEditing(false)
    },
    onError: () => notify('error', 'Failed to rename server'),
  })

  const save = () => {
    const trimmed = value.trim()
    if (!trimmed || trimmed === name) { setEditing(false); setValue(name); return }
    mutation.mutate(trimmed)
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="font-medium text-gray-800 text-sm truncate">{name}</span>
        <button
          onClick={() => { setValue(name); setEditing(true) }}
          className="text-gray-300 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0 shrink-0"
          title="Rename server"
          aria-label="Rename server"
        >
          ✎
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setEditing(false); setValue(name) } }}
        disabled={mutation.isPending}
        className="text-sm font-medium text-gray-800 border border-gray-300 rounded px-1.5 py-0.5 focus:border-blue-500 focus:outline-none disabled:opacity-50 min-w-0 w-40"
      />
      <button
        onClick={save}
        disabled={mutation.isPending}
        className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer bg-transparent border-0 disabled:opacity-50 shrink-0"
      >
        Save
      </button>
      <button
        onClick={() => { setEditing(false); setValue(name) }}
        disabled={mutation.isPending}
        className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 disabled:opacity-50 shrink-0"
      >
        Cancel
      </button>
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

// DiskRow renders one physical disk nested under its node's logical drive:
// label/device, a capacity fill bar, and temperature. Live figures from the
// node's agent push are preferred; when the node is offline it falls back to the
// last stored reading and is flagged offline.
function DiskRow({ disk, live, online }: { disk: NodeDisk; live?: DiskFrame; online: boolean }) {
  const total = online && live ? live.total_bytes : disk.capacity_bytes
  const used = online && live ? live.used_bytes : disk.used_bytes
  const temp = online && live ? live.temp_celsius : disk.temp_celsius
  const pct = total > 0 ? (used / total) * 100 : 0
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${online ? 'bg-green-400' : 'bg-gray-300'}`} />
          <span className="text-gray-700 font-medium truncate" title={disk.device || disk.label}>{disk.label}</span>
          {disk.device && <span className="text-gray-400 truncate">{disk.device}</span>}
          {temp != null && (
            <span className={`font-semibold tabular-nums shrink-0 ${tempColor(temp)}`} title="Disk temperature">
              {temp.toFixed(1)}°C
            </span>
          )}
          {!online && (
            <span className="text-gray-400 shrink-0" title="No online agent currently reports this disk — showing the last stored reading.">
              offline
            </span>
          )}
        </div>
        <span className="text-gray-400 shrink-0 tabular-nums">
          {fmtCapacity(used)} / {fmtCapacity(total)} · {pct.toFixed(1)}%
        </span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(pct, 100).toFixed(1)}%` }} />
      </div>
    </div>
  )
}

// NodeBlock renders a single swarm node read-only: status, hostname, role
// (manager/worker), address, its detected logical drive, and the physical disks
// nested beneath it. The infrastructure sync is the source of truth, so there are
// no edit/add/remove controls.
function NodeBlock({ group, driveStats, disks, liveNode }: {
  group: NodeGroup
  driveStats: Record<string, DriveStat>
  disks: NodeDisk[]
  liveNode?: NodeFrame
}) {
  const { node, drives } = group
  const liveDisks = liveNode?.online ? (liveNode.disks ?? []) : []

  return (
    <div className="border border-gray-100 rounded-lg px-3 py-3 bg-gray-50/60">
      <div className="flex items-center gap-2 mb-2 min-w-0">
        <span className={`w-2 h-2 rounded-full shrink-0 ${node.is_active ? 'bg-green-500' : 'bg-gray-300'}`} />
        <span className="font-medium text-gray-800 text-sm truncate">{node.hostname}</span>
        <span className={`text-xs font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0 ${roleBadgeClass(node.role)}`}>{node.role}</span>
        {node.address && <span className="text-xs text-gray-400 truncate">{node.address}</span>}
        <span className="text-xs text-gray-400 shrink-0">{drives.length} drive{drives.length !== 1 ? 's' : ''} · {disks.length} disk{disks.length !== 1 ? 's' : ''}</span>
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
      {disks.length > 0 && (
        <div className="mt-2 pl-4">
          <div className="text-xs font-medium text-gray-400 mb-1.5">Physical disks</div>
          <div className="flex flex-col gap-2">
            {disks.map((dk) => (
              <DiskRow key={dk.id} disk={dk} live={liveDisks.find(df => df.disk_id === dk.id)} online={liveDisks.some(df => df.disk_id === dk.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
