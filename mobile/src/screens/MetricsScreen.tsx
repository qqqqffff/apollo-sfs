import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Cpu, HardDrive, Monitor, RefreshCw, Server } from 'lucide-react-native';
import {
  ALARM_DEFAULT_THRESHOLD,
  ALARM_UNIT,
  deleteAlarmSubscription,
  getAlarmSubscriptions,
  getDriveIOHistory,
  getDriveStats,
  getDriveTempsHistory,
  getMetricsHistoryByHours,
  getNodeDiskIOHistory,
  getNodeDiskTempsHistory,
  getNodeMetricsHistory,
  getSpeedTest,
  listInfrastructure,
  pingAdminServer,
  runTests,
  shutdownServer,
  syncInfrastructure,
  triggerSpeedTest,
  upsertAlarmSubscription,
  type AlarmSubscription,
  type AlarmType,
  type DiskFrame,
  type DriveFrame,
  type DriveStat,
  type DriveSummary,
  type Infrastructure,
  type IOSnapshot,
  type MetricsFrame,
  type MetricsSnapshot,
  type NodeDisk,
  type NodeFrame,
  type NodeMetricSnapshot,
  type SpeedTestResult,
  type TestRunResponse,
  type TestSuiteEntry,
} from '../api/admin';
import { useMetricsStream } from '../hooks/useMetricsStream';
import { LineGraph, type LinePoint } from '../components/LineGraph';
import { card, colors, radius, spacing } from '../theme';

const GB = 1024 ** 3;
const HOUR_MS = 60 * 60 * 1000;

type HourWindow = 1 | 12 | 24 | 48 | 72;
const HOUR_OPTIONS: HourWindow[] = [1, 12, 24, 48, 72];

// Per-node metrics graph the selected node; cluster metrics are cluster-wide.
type MetricKey =
  | 'total_users' | 'active_users' | 'disk' | 'memory' | 'traffic' | 'speed'
  | 'ping' | 'loss' | 'cpu' | 'drive_temp' | 'disk_temp' | 'drive_io' | 'disk_io';

const NODE_METRICS: ReadonlySet<MetricKey> = new Set<MetricKey>([
  'cpu', 'memory', 'traffic', 'drive_temp', 'disk_temp', 'drive_io', 'disk_io',
]);

const METRIC_LABELS: Record<MetricKey, string> = {
  total_users: 'Total users',
  active_users: 'Active users',
  disk: 'Disk committed',
  memory: 'Memory',
  traffic: 'Network traffic',
  speed: 'Network speed',
  ping: 'Ping',
  loss: 'Packet loss',
  cpu: 'CPU utilization',
  drive_temp: 'Drive temperature',
  disk_temp: 'Disk temperature',
  drive_io: 'Drive speed',
  disk_io: 'Disk speed',
};

function fmtCapacity(bytes: number): string {
  const gb = bytes / GB;
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(0)} GB`;
}

function formatBytesPerSec(bps: number): string {
  if (bps < 0) bps = 0;
  const KB = 1024;
  const MB = KB * 1024;
  if (bps >= MB) return `${(bps / MB).toFixed(1)} MB/s`;
  if (bps >= KB) return `${(bps / KB).toFixed(1)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

function tempColor(c: number): string {
  if (c >= 60) return '#dc2626';
  if (c >= 45) return colors.warning;
  return colors.emerald;
}

function pingColor(ms: number | null): string {
  if (ms == null) return colors.textPrimary;
  if (ms >= 150) return '#dc2626';
  if (ms >= 60) return colors.warning;
  return colors.emerald;
}

function lossColor(pct: number | null): string {
  if (pct == null) return colors.textPrimary;
  if (pct >= 10) return '#dc2626';
  if (pct >= 1) return colors.warning;
  return colors.emerald;
}

const tMs = (iso: string) => new Date(iso).getTime();

// diffIORate turns cumulative (read_bytes, write_bytes) samples into
// bytes-per-second series — same cumulative-counter-diff technique as the web.
function diffIORate<T extends { read_bytes: number; write_bytes: number }>(
  samples: T[],
  tsOf: (s: T) => number,
): { read: LinePoint[]; write: LinePoint[] } {
  const read: LinePoint[] = [];
  const write: LinePoint[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const dtMs = tsOf(curr) - tsOf(prev);
    if (dtMs <= 0) continue;
    const readBps = ((curr.read_bytes - prev.read_bytes) / dtMs) * 1000;
    const writeBps = ((curr.write_bytes - prev.write_bytes) / dtMs) * 1000;
    if (readBps < 0 || writeBps < 0) continue;
    read.push({ x: tsOf(curr), y: readBps });
    write.push({ x: tsOf(curr), y: writeBps });
  }
  return { read, write };
}

export default function MetricsScreen() {
  const { width: windowW } = useWindowDimensions();
  const graphW = windowW - spacing.md * 2 - spacing.md * 2;

  const { frames, connected } = useMetricsStream();
  const snapshots = frames.map((f) => f.cluster);
  const latestFrame: MetricsFrame | undefined = frames[frames.length - 1];
  const latest: MetricsSnapshot | undefined = snapshots[snapshots.length - 1];

  const [hours, setHours] = useState<HourWindow>(12);
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('traffic');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [diskIdx, setDiskIdx] = useState(0);
  const [driveIdx, setDriveIdx] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const [infra, setInfra] = useState<Infrastructure | null>(null);
  const [driveStats, setDriveStats] = useState<Record<string, DriveStat>>({});
  const [speedTest, setSpeedTest] = useState<SpeedTestResult | null>(null);
  const [speedPending, setSpeedPending] = useState(false);
  const [syncPending, setSyncPending] = useState(false);
  const [shutdownConfirm, setShutdownConfirm] = useState(false);

  const [histSnaps, setHistSnaps] = useState<MetricsSnapshot[]>([]);
  const [nodeHist, setNodeHist] = useState<NodeMetricSnapshot[]>([]);
  const [driveTempHist, setDriveTempHist] = useState<{ temp_celsius: number; sampled_at: string }[]>([]);
  const [diskTempHist, setDiskTempHist] = useState<{ temp_celsius: number; sampled_at: string }[]>([]);
  const [driveIOHist, setDriveIOHist] = useState<IOSnapshot[]>([]);
  const [diskIOHist, setDiskIOHist] = useState<IOSnapshot[]>([]);

  const [testResult, setTestResult] = useState<TestRunResponse | null>(null);
  const [testsPending, setTestsPending] = useState(false);
  const [testOutputOpen, setTestOutputOpen] = useState(false);

  const loadInfra = useCallback(async () => {
    try {
      const [inf, stats] = await Promise.all([listInfrastructure(), getDriveStats()]);
      setInfra(inf);
      setDriveStats(stats);
    } catch {
      // non-fatal — the live stream still renders
    }
  }, []);

  useEffect(() => {
    loadInfra();
    const id = setInterval(loadInfra, 30_000);
    return () => clearInterval(id);
  }, [loadInfra]);

  useEffect(() => {
    getSpeedTest().then(setSpeedTest).catch(() => {});
  }, []);

  // ── Client ping (this device → server), 5s cadence like the web ────────────
  const [clientPingMs, setClientPingMs] = useState<number | null>(null);
  const [clientLossPct, setClientLossPct] = useState(0);
  const [clientPingHistory, setClientPingHistory] = useState<LinePoint[]>([]);
  useEffect(() => {
    let probes: { t: number; rtt: number | null }[] = [];
    let cancelled = false;
    async function probe() {
      let rtt: number | null = null;
      try {
        rtt = await pingAdminServer();
      } catch {
        // lost
      }
      if (cancelled) return;
      const now = Date.now();
      probes = [...probes, { t: now, rtt }].filter((p) => p.t >= now - HOUR_MS);
      const ok = probes.filter((p): p is { t: number; rtt: number } => p.rtt !== null);
      setClientPingMs(ok.length ? ok.reduce((s, v) => s + v.rtt, 0) / ok.length : null);
      setClientLossPct(((probes.length - ok.length) / probes.length) * 100);
      setClientPingHistory(ok.map((p) => ({ x: p.t, y: p.rtt })));
    }
    probe();
    const id = setInterval(probe, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ── Node selection ──────────────────────────────────────────────────────────
  const liveNodes: NodeFrame[] = latestFrame?.nodes ?? [];
  const nodes = infra?.nodes ?? [];
  const nodeTabs = nodes.length
    ? nodes.map((n) => ({ id: n.node_id, hostname: n.hostname, role: n.role as string }))
    : liveNodes.map((n) => ({ id: n.node_id, hostname: n.hostname, role: n.role }));
  useEffect(() => {
    if (nodeTabs.length === 0) return;
    if (!selectedNodeId || !nodeTabs.some((t) => t.id === selectedNodeId)) {
      setSelectedNodeId(nodeTabs[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeTabs.map((t) => t.id).join(','), selectedNodeId]);

  const selectedNode = liveNodes.find((n) => n.node_id === selectedNodeId);
  const nodeDrives: DriveFrame[] = selectedNode?.drives ?? [];
  const nodeDisks: DiskFrame[] = selectedNode?.disks ?? [];
  const safeDriveIdx = nodeDrives.length ? Math.min(driveIdx, nodeDrives.length - 1) : 0;
  const safeDiskIdx = nodeDisks.length ? Math.min(diskIdx, nodeDisks.length - 1) : 0;
  const selectedDrive = nodeDrives[safeDriveIdx];
  const selectedDisk = nodeDisks[safeDiskIdx];
  const selectedDriveId = selectedDrive?.drive_id;
  const selectedDiskId = selectedDisk?.disk_id;

  // ── History fetches (hours > 1) ─────────────────────────────────────────────
  useEffect(() => {
    if (hours <= 1) return;
    getMetricsHistoryByHours(hours).then(setHistSnaps).catch(() => setHistSnaps([]));
  }, [hours]);
  useEffect(() => {
    if (hours <= 1 || !selectedNodeId) return;
    getNodeMetricsHistory(selectedNodeId, hours).then(setNodeHist).catch(() => setNodeHist([]));
  }, [hours, selectedNodeId]);
  useEffect(() => {
    if (hours <= 1 || !selectedDriveId) return;
    getDriveTempsHistory(selectedDriveId, hours).then(setDriveTempHist).catch(() => setDriveTempHist([]));
    getDriveIOHistory(selectedDriveId, hours).then(setDriveIOHist).catch(() => setDriveIOHist([]));
  }, [hours, selectedDriveId]);
  useEffect(() => {
    if (hours <= 1 || !selectedDiskId) return;
    getNodeDiskTempsHistory(selectedDiskId, hours).then(setDiskTempHist).catch(() => setDiskTempHist([]));
    getNodeDiskIOHistory(selectedDiskId, hours).then(setDiskIOHist).catch(() => setDiskIOHist([]));
  }, [hours, selectedDiskId]);

  // ── Overall storage split (fast vs standard, across all servers) ────────────
  const drives = infra?.drives ?? [];
  const fastDrives = drives.filter((d) => d.drive_type === 'nvme');
  const standardDrives = drives.filter((d) => d.drive_type === 'hdd');
  const sumBytes = (ds: DriveSummary[], key: 'capacity_bytes' | 'allocated_quota_bytes') =>
    ds.reduce((s, d) => s + d[key], 0);
  const fastTier = {
    capacityBytes: sumBytes(fastDrives, 'capacity_bytes'),
    allocatedBytes: sumBytes(fastDrives, 'allocated_quota_bytes'),
  };
  const standardTier = {
    capacityBytes: sumBytes(standardDrives, 'capacity_bytes'),
    allocatedBytes: sumBytes(standardDrives, 'allocated_quota_bytes'),
  };

  // ── Live rate derivations (last two frames) ─────────────────────────────────
  const nowMs = Date.now();
  const recentFrames = useMemo(
    () => frames.filter((f) => tMs(f.cluster.sampled_at) >= nowMs - HOUR_MS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [frames],
  );
  const recentSnaps = recentFrames.map((f) => f.cluster);
  const nodeIn = (f: MetricsFrame) => f.nodes?.find((n) => n.node_id === selectedNodeId);

  let netSentRate: string | null = null;
  let netRecvRate: string | null = null;
  const ioRateByDiskId = new Map<string, { readBps: number; writeBps: number }>();
  const ioRateByDriveId = new Map<string, { readBps: number; writeBps: number }>();
  if (frames.length >= 2) {
    const prevN = nodeIn(frames[frames.length - 2]);
    const currN = nodeIn(frames[frames.length - 1]);
    const dtMs = prevN && currN
      ? tMs(frames[frames.length - 1].cluster.sampled_at) - tMs(frames[frames.length - 2].cluster.sampled_at)
      : 0;
    if (prevN && currN && dtMs > 0) {
      netSentRate = formatBytesPerSec(((currN.network_bytes_sent - prevN.network_bytes_sent) / dtMs) * 1000);
      netRecvRate = formatBytesPerSec(((currN.network_bytes_recv - prevN.network_bytes_recv) / dtMs) * 1000);
      const prevDiskById = new Map(prevN.disks.map((d) => [d.disk_id, d]));
      for (const d of currN.disks) {
        const p = prevDiskById.get(d.disk_id);
        if (!p) continue;
        ioRateByDiskId.set(d.disk_id, {
          readBps: Math.max(0, ((d.read_bytes - p.read_bytes) / dtMs) * 1000),
          writeBps: Math.max(0, ((d.write_bytes - p.write_bytes) / dtMs) * 1000),
        });
      }
      const prevDriveById = new Map(prevN.drives.map((d) => [d.drive_id, d]));
      for (const d of currN.drives) {
        const p = prevDriveById.get(d.drive_id);
        if (!p) continue;
        ioRateByDriveId.set(d.drive_id, {
          readBps: Math.max(0, ((d.read_bytes - p.read_bytes) / dtMs) * 1000),
          writeBps: Math.max(0, ((d.write_bytes - p.write_bytes) / dtMs) * 1000),
        });
      }
    }
  }

  // ── Graph point series for the selected metric ──────────────────────────────
  const graphSeries = useMemo((): { primary: LinePoint[]; secondary?: LinePoint[]; labels?: [string, string] } => {
    const live = hours === 1;

    const nodeSeries = (pick: (n: NodeFrame) => number | null): LinePoint[] =>
      recentFrames.flatMap((f) => {
        const n = nodeIn(f);
        const v = n ? pick(n) : null;
        return n && v != null ? [{ x: tMs(f.cluster.sampled_at), y: v }] : [];
      });

    switch (selectedMetric) {
      case 'cpu':
        return {
          primary: live
            ? nodeSeries((n) => n.cpu_percent)
            : nodeHist.map((s) => ({ x: tMs(s.sampled_at), y: s.cpu_percent })),
        };
      case 'memory':
        return {
          primary: live
            ? nodeSeries((n) => n.memory_used_bytes)
            : nodeHist.map((s) => ({ x: tMs(s.sampled_at), y: s.memory_used_bytes })),
        };
      case 'traffic': {
        const samples = live
          ? recentFrames.flatMap((f) => {
              const n = nodeIn(f);
              return n
                ? [{ read_bytes: n.network_bytes_recv, write_bytes: n.network_bytes_sent, sampled_at: f.cluster.sampled_at }]
                : [];
            })
          : nodeHist.map((s) => ({ read_bytes: s.network_bytes_recv, write_bytes: s.network_bytes_sent, sampled_at: s.sampled_at }));
        const { read, write } = diffIORate(samples, (s) => tMs(s.sampled_at));
        return { primary: write, secondary: read, labels: ['↑ Upload', '↓ Download'] };
      }
      case 'drive_temp': {
        const pts = live
          ? recentFrames.flatMap((f) => {
              const d = nodeIn(f)?.drives.find((dr) => dr.drive_id === selectedDriveId);
              return d && d.temp_celsius != null ? [{ x: tMs(f.cluster.sampled_at), y: d.temp_celsius }] : [];
            })
          : driveTempHist.map((s) => ({ x: tMs(s.sampled_at), y: s.temp_celsius }));
        return { primary: pts };
      }
      case 'disk_temp': {
        const pts = live
          ? recentFrames.flatMap((f) => {
              const d = nodeIn(f)?.disks?.find((dk) => dk.disk_id === selectedDiskId);
              return d && d.temp_celsius != null ? [{ x: tMs(f.cluster.sampled_at), y: d.temp_celsius }] : [];
            })
          : diskTempHist.map((s) => ({ x: tMs(s.sampled_at), y: s.temp_celsius }));
        return { primary: pts };
      }
      case 'drive_io': {
        const samples = live
          ? recentFrames.flatMap((f) => {
              const d = nodeIn(f)?.drives.find((dr) => dr.drive_id === selectedDriveId);
              return d ? [{ read_bytes: d.read_bytes, write_bytes: d.write_bytes, sampled_at: f.cluster.sampled_at }] : [];
            })
          : driveIOHist;
        const { read, write } = diffIORate(samples, (s) => tMs(s.sampled_at));
        return { primary: read, secondary: write, labels: ['↓ Read', '↑ Write'] };
      }
      case 'disk_io': {
        const samples = live
          ? recentFrames.flatMap((f) => {
              const d = nodeIn(f)?.disks?.find((dk) => dk.disk_id === selectedDiskId);
              return d ? [{ read_bytes: d.read_bytes, write_bytes: d.write_bytes, sampled_at: f.cluster.sampled_at }] : [];
            })
          : diskIOHist;
        const { read, write } = diffIORate(samples, (s) => tMs(s.sampled_at));
        return { primary: read, secondary: write, labels: ['↓ Read', '↑ Write'] };
      }
      case 'ping': {
        const server = (live ? recentSnaps : histSnaps)
          .filter((s) => s.server_isp_ping_ms != null)
          .map((s) => ({ x: tMs(s.sampled_at), y: s.server_isp_ping_ms! }));
        return { primary: live && server.length < 2 ? clientPingHistory : server };
      }
      case 'loss':
        return {
          primary: (live ? recentSnaps : histSnaps)
            .filter((s) => s.server_isp_packet_loss_percent != null)
            .map((s) => ({ x: tMs(s.sampled_at), y: s.server_isp_packet_loss_percent! })),
        };
      case 'speed': {
        const src = live ? recentSnaps : histSnaps;
        return {
          primary: src.filter((s) => s.speed_test_upload_mbps != null).map((s) => ({ x: tMs(s.sampled_at), y: s.speed_test_upload_mbps! })),
          secondary: src.filter((s) => s.speed_test_download_mbps != null).map((s) => ({ x: tMs(s.sampled_at), y: s.speed_test_download_mbps! })),
          labels: ['↑ Upload (Mbps)', '↓ Download (Mbps)'],
        };
      }
      case 'total_users':
        return { primary: (live ? recentSnaps : histSnaps).map((s) => ({ x: tMs(s.sampled_at), y: s.total_user_count })) };
      case 'active_users':
        return { primary: (live ? recentSnaps : histSnaps).map((s) => ({ x: tMs(s.sampled_at), y: s.active_user_count })) };
      case 'disk':
        return {
          primary: (live ? recentSnaps : histSnaps).map((s) => ({
            x: tMs(s.sampled_at),
            y: (s.disk_total_bytes - s.disk_free_bytes) + Math.max(0, s.storage_total_quota_bytes - s.storage_total_used_bytes),
          })),
        };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMetric, hours, recentFrames, histSnaps, nodeHist, driveTempHist, diskTempHist, driveIOHist, diskIOHist, selectedDriveId, selectedDiskId, clientPingHistory, selectedNodeId]);

  const graphFormatY = (() => {
    switch (selectedMetric) {
      case 'cpu': return (v: number) => `${v.toFixed(0)}%`;
      case 'ping': return (v: number) => `${v.toFixed(1)} ms`;
      case 'loss': return (v: number) => `${v.toFixed(1)}%`;
      case 'speed': return (v: number) => `${v.toFixed(1)} Mb/s`;
      case 'drive_temp':
      case 'disk_temp': return (v: number) => `${v.toFixed(1)}°C`;
      case 'traffic':
      case 'drive_io':
      case 'disk_io': return formatBytesPerSec;
      case 'total_users':
      case 'active_users': return (v: number) => v.toFixed(0);
      default: return undefined;
    }
  })();

  const formatGraphX = hours >= 24
    ? (ms: number) => {
        const d = new Date(ms);
        return `${d.toLocaleDateString([], { month: 'numeric', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }
    : undefined;

  // ── Derived cluster stats ───────────────────────────────────────────────────
  const diskUsedBytes = latest ? latest.disk_total_bytes - latest.disk_free_bytes : 0;
  const quotaOverheadBytes = latest
    ? Math.max(0, latest.storage_total_quota_bytes - latest.storage_total_used_bytes)
    : 0;
  const diskCommittedBytes = diskUsedBytes + quotaOverheadBytes;
  const diskCommittedPct = latest && latest.disk_total_bytes > 0
    ? (diskCommittedBytes / latest.disk_total_bytes) * 100
    : 0;
  const nodeMemPct = selectedNode && selectedNode.memory_total_bytes > 0
    ? (selectedNode.memory_used_bytes / selectedNode.memory_total_bytes) * 100
    : 0;

  const liveSpeedTest: SpeedTestResult | null =
    latest?.speed_test_upload_mbps != null
      ? {
          upload_mbps: latest.speed_test_upload_mbps!,
          download_mbps: latest.speed_test_download_mbps!,
          size_bytes: 0,
          tested_at: latest.speed_test_tested_at!,
          error: latest.speed_test_error ?? undefined,
        }
      : speedTest;

  // ── Actions ─────────────────────────────────────────────────────────────────
  const handleRunSpeedTest = async () => {
    setSpeedPending(true);
    try {
      setSpeedTest(await triggerSpeedTest());
    } catch (e: any) {
      Alert.alert('Speed test failed', e?.message ?? 'Unknown error');
    } finally {
      setSpeedPending(false);
    }
  };

  const handleSync = async () => {
    setSyncPending(true);
    try {
      const s = await syncInfrastructure();
      Alert.alert(
        'Infrastructure synced',
        `Synced ${s.nodes} node${s.nodes !== 1 ? 's' : ''} and ${s.drives} drive${s.drives !== 1 ? 's' : ''} across ${s.servers} server${s.servers !== 1 ? 's' : ''}`,
      );
      loadInfra();
    } catch {
      Alert.alert('Sync failed', 'Infrastructure sync failed');
    } finally {
      setSyncPending(false);
    }
  };

  const handleRunTests = async () => {
    setTestsPending(true);
    try {
      setTestResult(await runTests());
    } catch (e: any) {
      // 422 still returns the full result body with failures marked.
      const body = e?.response?.data;
      if (body?.backend) setTestResult(body as TestRunResponse);
      else Alert.alert('Failed to run tests', e?.message ?? 'Unknown error');
    } finally {
      setTestsPending(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadInfra(), getSpeedTest().then(setSpeedTest).catch(() => {})]);
    setRefreshing(false);
  };

  const selectDisk = (i: number) => {
    setDiskIdx(i);
    setDriveIdx(i);
  };

  const nodeLabel = (() => {
    const t = nodeTabs.find((tab) => tab.id === selectedNodeId);
    return t ? `${t.hostname}${t.role ? ` · ${t.role}` : ''}` : '';
  })();

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <Text style={styles.pageTitle}>System Metrics</Text>
        <View style={[styles.liveBadge, connected ? styles.liveBadgeOn : styles.liveBadgeOff]}>
          <Text style={[styles.liveBadgeText, { color: connected ? '#15803d' : '#dc2626' }]}>
            {connected ? 'Live' : 'Reconnecting…'}
          </Text>
        </View>
        <View style={{ flex: 1 }} />
        {shutdownConfirm ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TouchableOpacity
              style={styles.shutdownConfirmBtn}
              onPress={() => {
                setShutdownConfirm(false);
                shutdownServer().catch(() => Alert.alert('Shutdown request failed'));
              }}
            >
              <Text style={styles.shutdownConfirmText}>Confirm</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShutdownConfirm(false)}>
              <Text style={styles.shutdownCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={styles.shutdownBtn} onPress={() => setShutdownConfirm(true)}>
            <Text style={styles.shutdownBtnText}>Shutdown</Text>
          </TouchableOpacity>
        )}
      </View>
      {shutdownConfirm && (
        <Text style={styles.shutdownWarn}>Stop all containers and power off?</Text>
      )}

      {/* ── Server storage (fast vs standard) ── */}
      <Text style={styles.sectionTitle}>Server storage</Text>
      <View style={[card, styles.cardPad, { marginBottom: spacing.md }]}>
        <TierBar label="Fast (NVMe)" color={colors.info} tier={fastTier} />
        <View style={{ height: spacing.md }} />
        <TierBar label="Standard (HDD)" color={colors.warning} tier={standardTier} />
      </View>

      {/* ── Node hardware ── */}
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Node hardware</Text>
      </View>
      {nodeTabs.length > 1 && (
        <View style={styles.nodeTabs}>
          {nodeTabs.map((t) => {
            const active = t.id === selectedNodeId;
            return (
              <TouchableOpacity
                key={t.id}
                style={[styles.nodeTab, active && styles.nodeTabActive]}
                onPress={() => {
                  setSelectedNodeId(t.id);
                  setDriveIdx(0);
                  setDiskIdx(0);
                }}
              >
                {t.role === 'manager'
                  ? <Monitor size={12} color={active ? '#fff' : colors.textSecondary} />
                  : <HardDrive size={12} color={active ? '#fff' : colors.textSecondary} />}
                <Text style={[styles.nodeTabText, active && styles.nodeTabTextActive]}>{t.hostname}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      <View style={styles.cardGrid}>
        {/* CPU */}
        <MetricCard
          selected={selectedMetric === 'cpu'}
          onPress={() => setSelectedMetric('cpu')}
          label="CPU"
        >
          <KV label="Utilization" value={selectedNode ? `${selectedNode.cpu_percent.toFixed(0)}%` : '—'} />
          <KV
            label="Temperature"
            value={selectedNode?.cpu_temp_celsius != null ? `${selectedNode.cpu_temp_celsius.toFixed(1)}°C` : '—'}
            valueColor={selectedNode?.cpu_temp_celsius != null ? tempColor(selectedNode.cpu_temp_celsius) : undefined}
          />
          {!selectedNode?.online && <Text style={styles.cardHint}>no live data</Text>}
        </MetricCard>

        {/* Memory */}
        <MetricCard
          selected={selectedMetric === 'memory'}
          onPress={() => setSelectedMetric('memory')}
          label="Memory"
        >
          <Text style={styles.bigValue}>
            {selectedNode ? `${(selectedNode.memory_used_bytes / GB).toFixed(2)} GB` : '—'}
          </Text>
          <Text style={styles.cardHint}>
            {selectedNode
              ? `${nodeMemPct.toFixed(1)}% of ${(selectedNode.memory_total_bytes / GB).toFixed(1)} GB`
              : 'no live data'}
          </Text>
        </MetricCard>

        {/* Drive capacity (node aggregate) */}
        <MetricCard label="Drive capacity">
          {(() => {
            const items = nodeDisks.length ? nodeDisks : nodeDrives;
            const total = items.reduce((s, d) => s + d.total_bytes, 0);
            const used = items.reduce((s, d) => s + d.used_bytes, 0);
            const pct = total > 0 ? (used / total) * 100 : 0;
            if (items.length === 0) return <Text style={styles.cardHint}>no live data</Text>;
            return (
              <>
                <Text style={styles.bigValue}>{fmtCapacity(used)}</Text>
                <Text style={styles.cardHint}>
                  {pct.toFixed(1)}% of {fmtCapacity(total)} · {items.length} disk{items.length !== 1 ? 's' : ''}
                </Text>
              </>
            );
          })()}
        </MetricCard>

        {/* Disk usage carousel */}
        <MetricCard
          label="Disk usage"
          carousel={nodeDisks.length > 1 ? { index: safeDiskIdx, count: nodeDisks.length, onStep: (d) => selectDisk((safeDiskIdx + d + nodeDisks.length) % nodeDisks.length) } : undefined}
        >
          {selectedDisk ? (
            <>
              <View style={styles.rowBetween}>
                <Text style={styles.cardItemLabel} numberOfLines={1}>{selectedDisk.label}</Text>
                <Text style={styles.midValue}>
                  {selectedDisk.total_bytes > 0 ? `${((selectedDisk.used_bytes / selectedDisk.total_bytes) * 100).toFixed(1)}%` : '—'}
                </Text>
              </View>
              <UsageBar pct={selectedDisk.total_bytes > 0 ? (selectedDisk.used_bytes / selectedDisk.total_bytes) * 100 : 0} />
              <Text style={styles.cardHint}>
                {fmtCapacity(selectedDisk.used_bytes)} / {fmtCapacity(selectedDisk.total_bytes)}
              </Text>
            </>
          ) : (
            <Text style={styles.cardHint}>no live data</Text>
          )}
        </MetricCard>

        {/* Disk / drive speed carousel */}
        <MetricCard
          label={nodeDisks.length ? 'Disk speed' : 'Drive speed'}
          selected={selectedMetric === (nodeDisks.length ? 'disk_io' : 'drive_io')}
          onPress={() => setSelectedMetric(nodeDisks.length ? 'disk_io' : 'drive_io')}
          carousel={nodeDisks.length > 1 ? { index: safeDiskIdx, count: nodeDisks.length, onStep: (d) => selectDisk((safeDiskIdx + d + nodeDisks.length) % nodeDisks.length) } : undefined}
        >
          {(() => {
            const item = nodeDisks.length ? selectedDisk : selectedDrive;
            if (!item) return <Text style={styles.cardHint}>no live data</Text>;
            const rate = nodeDisks.length
              ? ioRateByDiskId.get((item as DiskFrame).disk_id)
              : ioRateByDriveId.get((item as DriveFrame).drive_id);
            const bps = rate ? rate.readBps + rate.writeBps : null;
            const pct = item.total_bytes > 0 ? (item.used_bytes / item.total_bytes) * 100 : 0;
            return (
              <>
                <View style={styles.rowBetween}>
                  <Text style={styles.cardItemLabel} numberOfLines={1}>{item.label}</Text>
                  <Text style={styles.midValue}>{bps != null ? formatBytesPerSec(bps) : '—'}</Text>
                </View>
                <Text style={styles.cardHint}>{pct.toFixed(1)}% used</Text>
              </>
            );
          })()}
        </MetricCard>

        {/* Disk / drive temp carousel */}
        <MetricCard
          label={nodeDisks.length ? 'Disk temp' : 'Drive temp'}
          selected={selectedMetric === (nodeDisks.length ? 'disk_temp' : 'drive_temp')}
          onPress={() => setSelectedMetric(nodeDisks.length ? 'disk_temp' : 'drive_temp')}
          carousel={nodeDisks.length > 1 ? { index: safeDiskIdx, count: nodeDisks.length, onStep: (d) => selectDisk((safeDiskIdx + d + nodeDisks.length) % nodeDisks.length) } : undefined}
        >
          {(() => {
            const item = nodeDisks.length ? selectedDisk : selectedDrive;
            if (!item) return <Text style={styles.cardHint}>no live data</Text>;
            return (
              <>
                <View style={styles.rowBetween}>
                  <Text style={styles.cardItemLabel} numberOfLines={1}>{item.label}</Text>
                  <Text style={[styles.midValue, item.temp_celsius != null && { color: tempColor(item.temp_celsius) }]}>
                    {item.temp_celsius != null ? `${item.temp_celsius.toFixed(1)}°C` : '—'}
                  </Text>
                </View>
                <Text style={styles.cardHint}>
                  {nodeDisks.length ? (item as DiskFrame).device || 'physical disk' : ((item as DriveFrame).drive_type === 'nvme' ? 'Fast' : 'Standard')}
                </Text>
              </>
            );
          })()}
        </MetricCard>
      </View>

      {/* ── Server network ── */}
      <Text style={styles.sectionTitle}>Server network</Text>
      <View style={styles.cardGrid}>
        <MetricCard label="Network traffic" selected={selectedMetric === 'traffic'} onPress={() => setSelectedMetric('traffic')}>
          <KV label="↑ Upload" value={netSentRate ?? '—'} />
          <KV label="↓ Download" value={netRecvRate ?? '—'} />
        </MetricCard>

        <MetricCard
          label="Network speed"
          selected={selectedMetric === 'speed'}
          onPress={() => setSelectedMetric('speed')}
          headerRight={
            <TouchableOpacity onPress={handleRunSpeedTest} disabled={speedPending} hitSlop={8}>
              {speedPending
                ? <ActivityIndicator size="small" color={colors.primary} />
                : <RefreshCw size={13} color={colors.primary} />}
            </TouchableOpacity>
          }
        >
          {liveSpeedTest && !liveSpeedTest.error ? (
            <>
              <KV label="↑ Upload" value={`${liveSpeedTest.upload_mbps.toFixed(1)} Mb/s`} />
              <KV label="↓ Download" value={`${liveSpeedTest.download_mbps.toFixed(1)} Mb/s`} />
              <Text style={styles.cardHint}>{new Date(liveSpeedTest.tested_at).toLocaleTimeString()}</Text>
            </>
          ) : liveSpeedTest?.error ? (
            <Text style={[styles.cardHint, { color: colors.error }]}>{liveSpeedTest.error}</Text>
          ) : (
            <Text style={styles.cardHint}>{speedPending ? 'Testing…' : '—'}</Text>
          )}
        </MetricCard>

        <MetricCard label="Ping" selected={selectedMetric === 'ping'} onPress={() => setSelectedMetric('ping')}>
          <KV
            label="Server → ISP"
            value={latest?.server_isp_ping_ms != null ? `${latest.server_isp_ping_ms.toFixed(1)} ms` : '—'}
            valueColor={pingColor(latest?.server_isp_ping_ms ?? null)}
          />
          <KV
            label="Client → Server"
            value={clientPingMs != null ? `${clientPingMs.toFixed(1)} ms` : '—'}
            valueColor={pingColor(clientPingMs)}
          />
        </MetricCard>

        <MetricCard label="Packet loss" selected={selectedMetric === 'loss'} onPress={() => setSelectedMetric('loss')}>
          <KV
            label="Server → ISP"
            value={latest?.server_isp_packet_loss_percent != null ? `${latest.server_isp_packet_loss_percent.toFixed(1)}%` : '—'}
            valueColor={lossColor(latest?.server_isp_packet_loss_percent ?? null)}
          />
          <KV label="Client → Server" value={`${clientLossPct.toFixed(1)}%`} valueColor={lossColor(clientLossPct)} />
        </MetricCard>
      </View>

      {/* ── Users & storage ── */}
      <Text style={styles.sectionTitle}>Users & storage</Text>
      <View style={styles.cardGrid}>
        <MetricCard label="Total users" selected={selectedMetric === 'total_users'} onPress={() => setSelectedMetric('total_users')}>
          <Text style={styles.bigValue}>{latest ? String(latest.total_user_count) : '—'}</Text>
        </MetricCard>
        <MetricCard label="Active (5 min)" selected={selectedMetric === 'active_users'} onPress={() => setSelectedMetric('active_users')}>
          <Text style={styles.bigValue}>{latest ? String(latest.active_user_count) : '—'}</Text>
        </MetricCard>
        <MetricCard label="Disk committed" selected={selectedMetric === 'disk'} onPress={() => setSelectedMetric('disk')}>
          <Text style={styles.bigValue}>{latest ? `${(diskCommittedBytes / GB).toFixed(1)} GB` : '—'}</Text>
          {latest && (
            <Text style={styles.cardHint}>
              {diskCommittedPct.toFixed(1)}% of {(latest.disk_total_bytes / GB).toFixed(0)} GB
            </Text>
          )}
        </MetricCard>
      </View>

      {/* ── Metric graph ── */}
      <Text style={styles.sectionTitle}>
        {METRIC_LABELS[selectedMetric]}
        {NODE_METRICS.has(selectedMetric) && selectedNode ? ` · ${selectedNode.hostname}` : ''}
        {selectedMetric === 'drive_temp' && selectedDrive ? ` · ${selectedDrive.label}` : ''}
        {selectedMetric === 'disk_temp' && selectedDisk ? ` · ${selectedDisk.label}` : ''}
        {selectedMetric === 'drive_io' && selectedDrive ? ` · ${selectedDrive.label}` : ''}
        {selectedMetric === 'disk_io' && selectedDisk ? ` · ${selectedDisk.label}` : ''}
        {' '}over time
      </Text>
      <View style={styles.hourRow}>
        {HOUR_OPTIONS.map((h) => (
          <TouchableOpacity
            key={h}
            style={[styles.hourBtn, hours === h && styles.hourBtnActive]}
            onPress={() => setHours(h)}
          >
            <Text style={[styles.hourBtnText, hours === h && styles.hourBtnTextActive]}>{h}hr</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={[card, styles.cardPad, { marginBottom: spacing.md }]}>
        {graphSeries.labels ? (
          <>
            <Text style={styles.graphSeriesLabel}>{graphSeries.labels[0]}</Text>
            <LineGraph points={graphSeries.primary} width={graphW} height={140} color={colors.info} formatY={graphFormatY} formatX={formatGraphX} />
            <Text style={[styles.graphSeriesLabel, { marginTop: spacing.sm }]}>{graphSeries.labels[1]}</Text>
            <LineGraph points={graphSeries.secondary ?? []} width={graphW} height={140} color={colors.emerald} formatY={graphFormatY} formatX={formatGraphX} />
          </>
        ) : (
          <LineGraph points={graphSeries.primary} width={graphW} height={180} color={colors.info} formatY={graphFormatY} formatX={formatGraphX} />
        )}
      </View>

      {/* ── Alarms (moved here from the profile page) ── */}
      <MetricAlarms
        selectedMetric={selectedMetric}
        nodeId={selectedNodeId}
        nodeLabel={nodeLabel}
        driveId={selectedDrive?.drive_id ?? null}
        driveLabel={selectedDrive?.label ?? ''}
      />

      {/* ── Tests ── */}
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Tests</Text>
        <TouchableOpacity style={styles.smallPrimaryBtn} onPress={handleRunTests} disabled={testsPending}>
          <Text style={styles.smallPrimaryBtnText}>{testsPending ? 'Running…' : 'Run tests'}</Text>
        </TouchableOpacity>
      </View>
      <View style={[card, styles.cardPad, { marginBottom: spacing.md }]}>
        {!testResult && !testsPending && (
          <Text style={styles.mutedText}>No test run yet. Tap "Run tests" to execute the suite.</Text>
        )}
        {testsPending && <Text style={styles.mutedText}>Running test suites…</Text>}
        {testResult && (
          <>
            <TestSuiteRow label="Backend" entry={testResult.backend} />
            <TestSuiteRow label="Frontend" entry={testResult.frontend} />
            <TestSuiteRow label="Frontend E2E" entry={testResult.frontend_e2e} />
            <TouchableOpacity onPress={() => setTestOutputOpen((o) => !o)}>
              <Text style={styles.testOutputToggle}>{testOutputOpen ? '▲ Hide output' : '▼ Show output'}</Text>
            </TouchableOpacity>
            {testOutputOpen && (
              <>
                {([['Backend', testResult.backend], ['Frontend', testResult.frontend], ['Frontend E2E', testResult.frontend_e2e]] as [string, TestSuiteEntry][])
                  .filter(([, e]) => e.enabled && e.result)
                  .map(([label, e]) => (
                    <View key={label} style={{ marginTop: spacing.sm }}>
                      <Text style={styles.cardHint}>{label}</Text>
                      <ScrollView horizontal style={styles.outputBlock}>
                        <Text style={styles.outputText}>{e.result!.output || '(no output)'}</Text>
                      </ScrollView>
                    </View>
                  ))}
              </>
            )}
          </>
        )}
      </View>

      {/* ── Infrastructure ── */}
      <View style={styles.sectionHeaderRow}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, flex: 1 }}>
          <Text style={styles.sectionTitle}>Infrastructure</Text>
          <Text style={styles.cardHint}>auto-detected from the swarm</Text>
        </View>
        <TouchableOpacity style={styles.smallPrimaryBtn} onPress={handleSync} disabled={syncPending}>
          <Text style={styles.smallPrimaryBtnText}>{syncPending ? 'Syncing…' : 'Sync'}</Text>
        </TouchableOpacity>
      </View>
      <InfrastructureTree infra={infra} driveStats={driveStats} liveNodes={liveNodes} />
    </ScrollView>
  );
}

// ── Alarm configuration (per-metric + persistent cluster row) ────────────────

function MetricAlarms({ selectedMetric, nodeId, nodeLabel, driveId, driveLabel }: {
  selectedMetric: MetricKey;
  nodeId: string | null;
  nodeLabel: string;
  driveId: string | null;
  driveLabel: string;
}) {
  const [subs, setSubs] = useState<AlarmSubscription[]>([]);
  const [pending, setPending] = useState(false);

  const load = useCallback(() => {
    getAlarmSubscriptions().then(setSubs).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const find = (type: AlarmType, nId: string | null, dId: string | null) =>
    subs.find((s) => s.alarm_type === type && (s.node_id ?? null) === nId && (s.drive_id ?? null) === dId);

  const mutate = async (fn: () => Promise<unknown>) => {
    setPending(true);
    try {
      await fn();
      load();
    } catch (e: any) {
      Alert.alert('Failed to update alarm', e?.message ?? 'Unknown error');
    } finally {
      setPending(false);
    }
  };

  type Row = { type: AlarmType; label: string; description: string };
  let rows: Row[] = [];
  let scopeNodeId: string | null = null;
  let scopeDriveId: string | null = null;
  let targetLabel = '';

  if (selectedMetric === 'cpu' && nodeId) {
    rows = [
      { type: 'cpu_usage', label: 'High CPU usage', description: 'Average CPU over 30 min exceeds the threshold.' },
      { type: 'cpu_temp', label: 'High CPU temperature', description: 'Average CPU temperature over 30 min exceeds the threshold.' },
    ];
    scopeNodeId = nodeId;
    targetLabel = nodeLabel;
  } else if (selectedMetric === 'memory' && nodeId) {
    rows = [{ type: 'memory', label: 'High memory usage', description: 'Average memory over 30 min exceeds the threshold.' }];
    scopeNodeId = nodeId;
    targetLabel = nodeLabel;
  } else if (selectedMetric === 'traffic' && nodeId) {
    rows = [{ type: 'network_traffic', label: 'High network traffic', description: 'Average throughput over 30 min exceeds the % of the last speed test.' }];
    scopeNodeId = nodeId;
    targetLabel = nodeLabel;
  } else if ((selectedMetric === 'drive_temp' || selectedMetric === 'disk_temp') && driveId) {
    rows = [
      { type: 'drive_temp', label: 'High drive temperature', description: 'Average drive temperature over 30 min exceeds the threshold.' },
      { type: 'drive_load', label: 'High drive load', description: 'Allocated capacity exceeds the threshold.' },
    ];
    scopeDriveId = driveId;
    targetLabel = driveLabel;
  }

  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
        <Text style={styles.sectionTitle}>Alarms</Text>
        <Text style={styles.cardHint}>emailed to you · 30-min sustained · 1-hr cooldown</Text>
      </View>
      <View style={[card, { marginBottom: spacing.md }]}>
        {rows.length === 0 && (
          <Text style={[styles.mutedText, { padding: spacing.md }]}>
            No node/drive alarms apply to this metric. Select CPU, Memory, Network traffic, or Drive temperature to configure them.
          </Text>
        )}
        {rows.map((r, i) => (
          <AlarmConfigRow
            key={r.type}
            first={i === 0 && rows.length > 0}
            alarmType={r.type}
            label={r.label}
            description={r.description}
            targetLabel={targetLabel}
            subscription={find(r.type, scopeNodeId, scopeDriveId)}
            pending={pending}
            onUpsert={(threshold) => mutate(() => upsertAlarmSubscription({
              alarm_type: r.type,
              node_id: scopeNodeId ?? undefined,
              drive_id: scopeDriveId ?? undefined,
              threshold,
            }))}
            onRemove={() => mutate(() => deleteAlarmSubscription({
              alarm_type: r.type,
              node_id: scopeNodeId ?? undefined,
              drive_id: scopeDriveId ?? undefined,
            }))}
          />
        ))}
        <AlarmConfigRow
          first={rows.length === 0}
          alarmType="api_error_rate"
          label="Elevated API error rate"
          description="Cluster-wide: percentage of API requests returning a server error over 30 min."
          targetLabel="Cluster"
          subscription={find('api_error_rate', null, null)}
          pending={pending}
          onUpsert={(threshold) => mutate(() => upsertAlarmSubscription({ alarm_type: 'api_error_rate', threshold }))}
          onRemove={() => mutate(() => deleteAlarmSubscription({ alarm_type: 'api_error_rate' }))}
        />
      </View>
    </>
  );
}

// AlarmConfigRow mirrors the web's AlarmConfig: a subscribe toggle plus an
// editable threshold, with the last-fired timestamp when subscribed.
function AlarmConfigRow({ first, alarmType, label, description, targetLabel, subscription, pending, onUpsert, onRemove }: {
  first?: boolean;
  alarmType: AlarmType;
  label: string;
  description?: string;
  targetLabel?: string;
  subscription?: AlarmSubscription;
  pending?: boolean;
  onUpsert: (threshold: number) => void;
  onRemove: () => void;
}) {
  const subscribed = !!subscription;
  const [threshold, setThreshold] = useState<string>(
    String(subscription?.threshold ?? ALARM_DEFAULT_THRESHOLD[alarmType]),
  );

  useEffect(() => {
    setThreshold(String(subscription?.threshold ?? ALARM_DEFAULT_THRESHOLD[alarmType]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscription?.id, subscription?.threshold, alarmType]);

  const commitThreshold = () => {
    if (!subscribed) return;
    const v = Number(threshold);
    if (!Number.isFinite(v) || v <= 0 || v === subscription?.threshold) return;
    onUpsert(v);
  };

  const toggle = (next: boolean) => {
    if (!next) {
      onRemove();
    } else {
      const v = Number(threshold);
      onUpsert(Number.isFinite(v) && v > 0 ? v : ALARM_DEFAULT_THRESHOLD[alarmType]);
    }
  };

  return (
    <View style={[styles.alarmRow, !first && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
      <View style={{ flex: 1, marginRight: spacing.sm }}>
        <Text style={styles.alarmLabel}>{label}</Text>
        {!!targetLabel && <Text style={styles.cardHint}>{targetLabel}</Text>}
        {!!description && <Text style={styles.alarmDesc}>{description}</Text>}
        {subscribed && (
          <Text style={styles.cardHint}>
            Last sent: {subscription?.last_fired_at ? new Date(subscription.last_fired_at).toLocaleString() : 'Never'}
          </Text>
        )}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, opacity: subscribed ? 1 : 0.4 }}>
          <TextInput
            style={styles.thresholdInput}
            value={threshold}
            editable={subscribed && !pending}
            keyboardType="decimal-pad"
            onChangeText={setThreshold}
            onBlur={commitThreshold}
          />
          <Text style={styles.cardHint}>{ALARM_UNIT[alarmType]}</Text>
        </View>
        <Switch
          value={subscribed}
          disabled={pending}
          onValueChange={toggle}
          trackColor={{ false: colors.border, true: colors.primary }}
        />
      </View>
    </View>
  );
}

// ── Infrastructure tree (read-only, server → node → drive → disks) ──────────

function InfrastructureTree({ infra, driveStats, liveNodes }: {
  infra: Infrastructure | null;
  driveStats: Record<string, DriveStat>;
  liveNodes: NodeFrame[];
}) {
  if (!infra || (infra.nodes.length === 0 && infra.drives.length === 0)) {
    return (
      <Text style={[styles.mutedText, { marginBottom: spacing.xl }]}>
        No infrastructure indexed yet. Tap "Sync" to detect the swarm.
      </Text>
    );
  }

  type ServerGroup = {
    serverId: string;
    name: string;
    isActive: boolean;
    nodes: { node: (typeof infra.nodes)[number]; drives: DriveSummary[] }[];
    unassigned: DriveSummary[];
  };
  const serverMap = new Map<string, ServerGroup>();
  const ensure = (id: string, name: string, isActive: boolean): ServerGroup => {
    let s = serverMap.get(id);
    if (!s) {
      s = { serverId: id, name, isActive, nodes: [], unassigned: [] };
      serverMap.set(id, s);
    }
    return s;
  };
  const nodeMap = new Map<string, ServerGroup['nodes'][number]>();
  for (const n of infra.nodes) {
    const s = ensure(n.server_id, n.server_name, n.server_is_active);
    const ng = { node: n, drives: [] as DriveSummary[] };
    s.nodes.push(ng);
    nodeMap.set(n.node_id, ng);
  }
  for (const d of infra.drives) {
    const s = ensure(d.server_id, d.server_name, d.server_is_active);
    const ng = d.node_id ? nodeMap.get(d.node_id) : undefined;
    if (ng) ng.drives.push(d);
    else s.unassigned.push(d);
  }
  const disksByNode = new Map<string, NodeDisk[]>();
  for (const dk of infra.disks ?? []) {
    const arr = disksByNode.get(dk.node_id);
    if (arr) arr.push(dk);
    else disksByNode.set(dk.node_id, [dk]);
  }

  return (
    <View style={{ marginBottom: spacing.xl, gap: spacing.md }}>
      {Array.from(serverMap.values()).map((srv) => (
        <View key={srv.serverId} style={[card, styles.cardPad]}>
          <View style={styles.rowStart}>
            <View style={[styles.statusDot, { backgroundColor: srv.isActive ? '#22c55e' : colors.border }]} />
            <Text style={styles.infraServerName}>{srv.name}</Text>
            {!srv.isActive && <Text style={styles.cardHint}>(inactive)</Text>}
          </View>
          {srv.nodes.length === 0 && srv.unassigned.length === 0 && (
            <Text style={styles.cardHint}>No nodes detected on this server.</Text>
          )}
          {srv.nodes.map((ng) => {
            const liveNode = liveNodes.find((ln) => ln.node_id === ng.node.node_id);
            const liveDisks = liveNode?.online ? liveNode.disks ?? [] : [];
            const disks = disksByNode.get(ng.node.node_id) ?? [];
            return (
              <View key={ng.node.node_id} style={styles.nodeBlock}>
                <View style={styles.rowStart}>
                  <View style={[styles.statusDot, { backgroundColor: ng.node.is_active ? '#22c55e' : colors.border }]} />
                  <Text style={styles.infraNodeName} numberOfLines={1}>{ng.node.hostname}</Text>
                  <View style={[styles.roleBadge, ng.node.role === 'manager' ? styles.roleBadgeManager : styles.roleBadgeStorage]}>
                    <Text style={[styles.roleBadgeText, { color: ng.node.role === 'manager' ? '#4338ca' : '#047857' }]}>
                      {ng.node.role}
                    </Text>
                  </View>
                  <Text style={styles.cardHint}>
                    {ng.drives.length} drive{ng.drives.length !== 1 ? 's' : ''} · {disks.length} disk{disks.length !== 1 ? 's' : ''}
                  </Text>
                </View>
                {ng.drives.length === 0 ? (
                  <Text style={[styles.cardHint, { paddingLeft: 14 }]}>No drives detected on this node.</Text>
                ) : (
                  ng.drives.map((d) => <DriveBarRow key={d.drive_id} drive={d} stat={driveStats[d.drive_id]} />)
                )}
                {disks.length > 0 && (
                  <View style={{ paddingLeft: 14, marginTop: 4, gap: 6 }}>
                    <Text style={styles.cardHint}>Physical disks</Text>
                    {disks.map((dk) => {
                      const live = liveDisks.find((df) => df.disk_id === dk.id);
                      const online = !!live;
                      const total = online ? live!.total_bytes : dk.capacity_bytes;
                      const used = online ? live!.used_bytes : dk.used_bytes;
                      const temp = online ? live!.temp_celsius : dk.temp_celsius;
                      const pct = total > 0 ? (used / total) * 100 : 0;
                      return (
                        <View key={dk.id}>
                          <View style={styles.rowBetween}>
                            <View style={[styles.rowStart, { flex: 1 }]}>
                              <View style={[styles.statusDotSm, { backgroundColor: online ? '#4ade80' : colors.border }]} />
                              <Text style={styles.infraDiskLabel} numberOfLines={1}>{dk.label}</Text>
                              {temp != null && (
                                <Text style={[styles.infraDiskTemp, { color: tempColor(temp) }]}>{temp.toFixed(1)}°C</Text>
                              )}
                              {!online && <Text style={styles.cardHint}>offline</Text>}
                            </View>
                            <Text style={styles.cardHint}>
                              {fmtCapacity(used)} / {fmtCapacity(total)} · {pct.toFixed(1)}%
                            </Text>
                          </View>
                          <UsageBar pct={pct} />
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>
            );
          })}
          {srv.unassigned.length > 0 && (
            <View style={styles.unassignedBlock}>
              <Text style={styles.cardHint}>Unassigned drives (no node)</Text>
              {srv.unassigned.map((d) => <DriveBarRow key={d.drive_id} drive={d} stat={driveStats[d.drive_id]} />)}
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

function DriveBarRow({ drive, stat }: { drive: DriveSummary; stat?: DriveStat }) {
  const syncRequired = drive.capacity_bytes === 0;
  const live = stat?.online ?? false;
  const totalBytes = live ? stat!.total_bytes : drive.capacity_bytes;
  const usedBytes = live ? stat!.used_bytes : drive.used_bytes;
  const overAllocated = !syncRequired && drive.allocated_quota_bytes > drive.capacity_bytes;
  const cap = totalBytes || 1;
  const allocPct = Math.min(100, (drive.allocated_quota_bytes / cap) * 100);
  const usedPct = Math.min(100, (usedBytes / cap) * 100);
  const temp = stat?.temp_celsius;

  return (
    <View style={{ paddingLeft: 14, marginTop: 6 }}>
      <View style={styles.rowBetween}>
        <View style={[styles.rowStart, { flex: 1 }]}>
          <View style={[styles.statusDotSm, { backgroundColor: drive.drive_is_active ? '#4ade80' : colors.border }]} />
          <Text style={styles.infraDiskLabel} numberOfLines={1}>{drive.drive_label}</Text>
          <View style={[styles.tierBadge, drive.drive_type === 'nvme' ? styles.tierBadgeFast : styles.tierBadgeStd]}>
            <Text style={[styles.tierBadgeText, { color: drive.drive_type === 'nvme' ? '#047857' : colors.textSecondary }]}>
              {drive.drive_type === 'nvme' ? 'Fast' : 'Standard'}
            </Text>
          </View>
          {temp != null && <Text style={[styles.infraDiskTemp, { color: tempColor(temp) }]}>{temp.toFixed(1)}°C</Text>}
          {syncRequired && <Text style={[styles.cardHint, { color: colors.warning }]}>⚠ Sync required</Text>}
          {overAllocated && <Text style={[styles.cardHint, { color: colors.error }]}>⚠ over-allocated</Text>}
        </View>
      </View>
      {!syncRequired && (
        <>
          <View style={styles.allocBarTrack}>
            <View style={[styles.allocBarAlloc, { width: `${allocPct.toFixed(1)}%` as any }]} />
            <View style={[styles.allocBarUsed, { width: `${usedPct.toFixed(1)}%` as any }]} />
          </View>
          <Text style={styles.cardHint}>
            {(usedBytes / GB).toFixed(1)} GB used · {(drive.allocated_quota_bytes / GB).toFixed(1)} GB allocated / {fmtCapacity(totalBytes)}
          </Text>
        </>
      )}
    </View>
  );
}

// ── Small building blocks ─────────────────────────────────────────────────────

function TierBar({ label, color, tier }: {
  label: string;
  color: string;
  tier: { capacityBytes: number; allocatedBytes: number };
}) {
  const pct = tier.capacityBytes > 0 ? Math.min(100, (tier.allocatedBytes / tier.capacityBytes) * 100) : 0;
  return (
    <View>
      <View style={styles.rowBetween}>
        <Text style={styles.cardItemLabel}>{label}</Text>
        <Text style={styles.cardHint}>
          {fmtCapacity(tier.allocatedBytes)} allocated / {fmtCapacity(tier.capacityBytes)}
        </Text>
      </View>
      <View style={styles.usageTrack}>
        <View style={[styles.usageFill, { width: `${pct}%` as any, backgroundColor: color }]} />
      </View>
      <Text style={styles.cardHint}>{pct.toFixed(1)}% allocated</Text>
    </View>
  );
}

function UsageBar({ pct }: { pct: number }) {
  const color = pct >= 90 ? colors.error : pct >= 75 ? colors.warning : colors.emerald;
  return (
    <View style={styles.usageTrack}>
      <View style={[styles.usageFill, { width: `${Math.min(pct, 100)}%` as any, backgroundColor: color }]} />
    </View>
  );
}

function MetricCard({ label, children, selected, onPress, headerRight, carousel }: {
  label: string;
  children: React.ReactNode;
  selected?: boolean;
  onPress?: () => void;
  headerRight?: React.ReactNode;
  carousel?: { index: number; count: number; onStep: (delta: number) => void };
}) {
  const body = (
    <>
      <View style={styles.rowBetween}>
        <Text style={styles.cardLabel}>{label}</Text>
        {carousel ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <TouchableOpacity onPress={() => carousel.onStep(-1)} hitSlop={8}>
              <Text style={styles.carouselArrow}>‹</Text>
            </TouchableOpacity>
            <Text style={styles.cardHint}>{carousel.index + 1}/{carousel.count}</Text>
            <TouchableOpacity onPress={() => carousel.onStep(1)} hitSlop={8}>
              <Text style={styles.carouselArrow}>›</Text>
            </TouchableOpacity>
          </View>
        ) : headerRight}
      </View>
      {children}
    </>
  );
  const style = [card, styles.metricCard, selected && styles.metricCardSelected];
  if (onPress) {
    return (
      <TouchableOpacity style={style} onPress={onPress} activeOpacity={0.8}>
        {body}
      </TouchableOpacity>
    );
  }
  return <View style={style}>{body}</View>;
}

function KV({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={styles.rowBetween}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={[styles.kvValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
    </View>
  );
}

// parseSuiteDetail extracts a human-readable count summary from runner output
// (Go "ok" lines, Jest "Test Suites: …", Playwright "N passed") — same
// heuristics as the web metrics page.
function parseSuiteDetail(output: string, passed: boolean): string | null {
  if (!output) return null;
  const goOk = (output.match(/^ok\s+\S+/gm) ?? []).length;
  const goFail = (output.match(/^FAIL\s+\S+/gm) ?? []).length;
  if (goOk > 0 || goFail > 0) {
    return passed
      ? `${goOk} suite${goOk !== 1 ? 's' : ''} passing`
      : `${goFail} suite${goFail !== 1 ? 's' : ''} failing · ${goOk} passing`;
  }
  const suiteMatch = output.match(/Test Suites:\s+(?:(\d+) failed,\s*)?(\d+) passed,\s*(\d+) total/);
  const testMatch = output.match(/Tests:\s+(?:(\d+) failed,\s*)?(\d+) passed,\s*(\d+) total/);
  if (suiteMatch && testMatch) {
    const suiteFail = parseInt(suiteMatch[1] ?? '0', 10);
    const suitePass = parseInt(suiteMatch[2], 10);
    const testFail = parseInt(testMatch[1] ?? '0', 10);
    const testPass = parseInt(testMatch[2], 10);
    if (passed) return `${suitePass}/${suitePass + suiteFail} suites · ${testPass}/${testPass + testFail} tests passing`;
    return `${suiteFail} suite${suiteFail !== 1 ? 's' : ''} failing · ${testFail} test${testFail !== 1 ? 's' : ''} failing`;
  }
  const pwPass = output.match(/(\d+) passed/);
  const pwFail = output.match(/(\d+) failed/);
  if (pwPass) {
    const p = parseInt(pwPass[1], 10);
    const f = pwFail ? parseInt(pwFail[1], 10) : 0;
    if (passed) return `${p} test${p !== 1 ? 's' : ''} passing`;
    return f > 0 ? `${f} test${f !== 1 ? 's' : ''} failing · ${p} passing` : `${p} test${p !== 1 ? 's' : ''} passing`;
  }
  return null;
}

function TestSuiteRow({ label, entry }: { label: string; entry: TestSuiteEntry }) {
  if (!entry.enabled) {
    return (
      <View style={styles.testRow}>
        <View style={[styles.statusDot, { backgroundColor: colors.border }]} />
        <Text style={styles.testLabel}>{label}</Text>
        <Text style={styles.cardHint}>{entry.message ?? 'disabled'}</Text>
      </View>
    );
  }
  const passed = entry.result?.passed;
  const detail = entry.result ? parseSuiteDetail(entry.result.output, !!passed) : null;
  return (
    <View style={styles.testRow}>
      <View style={[styles.statusDot, { backgroundColor: passed ? '#22c55e' : colors.error }]} />
      <Text style={styles.testLabel}>{label}</Text>
      <Text style={[styles.testStatus, { color: passed ? colors.success : colors.error }]}>
        {passed ? 'PASS' : 'FAIL'}
      </Text>
      {detail && <Text style={styles.cardHint} numberOfLines={1}>{detail}</Text>}
      {entry.result && <Text style={styles.cardHint}>{entry.result.duration_ms} ms</Text>}
    </View>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _icons = { Cpu, Server }; // referenced to keep parity with web iconography

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  pageTitle: { fontSize: 18, fontWeight: '600', color: colors.textPrimary },
  liveBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  liveBadgeOn: { backgroundColor: '#dcfce7' },
  liveBadgeOff: { backgroundColor: colors.errorBg },
  liveBadgeText: { fontSize: 11, fontWeight: '600' },

  shutdownBtn: { borderWidth: 1, borderColor: '#fecaca', borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 4 },
  shutdownBtnText: { fontSize: 11, color: colors.error },
  shutdownConfirmBtn: { backgroundColor: '#dc2626', borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 4 },
  shutdownConfirmText: { fontSize: 11, color: '#fff', fontWeight: '600' },
  shutdownCancelText: { fontSize: 11, color: colors.textSecondary },
  shutdownWarn: { fontSize: 12, color: colors.error, fontWeight: '500', marginBottom: spacing.sm },

  sectionTitle: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: spacing.sm, marginTop: spacing.xs },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },

  nodeTabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: spacing.sm },
  nodeTab: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm,
    backgroundColor: colors.surface, paddingHorizontal: 10, paddingVertical: 5,
  },
  nodeTabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  nodeTabText: { fontSize: 12, color: colors.textSecondary },
  nodeTabTextActive: { color: '#fff', fontWeight: '600' },

  cardGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  metricCard: { flexBasis: '47%', flexGrow: 1, paddingHorizontal: 14, paddingVertical: 12, gap: 4 },
  metricCardSelected: { borderColor: colors.primary, borderWidth: 1.5 },
  cardPad: { paddingHorizontal: 16, paddingVertical: 14 },
  cardLabel: { fontSize: 11, color: colors.textMuted, marginBottom: 2 },
  cardHint: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  cardItemLabel: { fontSize: 12, fontWeight: '500', color: colors.textSecondary, flexShrink: 1 },
  bigValue: { fontSize: 20, fontWeight: '600', color: colors.textPrimary },
  midValue: { fontSize: 16, fontWeight: '600', color: colors.textPrimary },

  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  rowStart: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' },

  kvLabel: { fontSize: 12, color: colors.textSecondary },
  kvValue: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },

  carouselArrow: { fontSize: 16, color: colors.textMuted, paddingHorizontal: 2 },

  usageTrack: { height: 6, backgroundColor: colors.divider, borderRadius: 3, overflow: 'hidden', marginTop: 6 },
  usageFill: { height: '100%', borderRadius: 3 },

  hourRow: { flexDirection: 'row', gap: 6, marginBottom: spacing.sm },
  hourBtn: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm,
    backgroundColor: colors.surface, paddingHorizontal: 10, paddingVertical: 5,
  },
  hourBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  hourBtnText: { fontSize: 12, color: colors.textSecondary },
  hourBtnTextActive: { color: '#fff', fontWeight: '600' },
  graphSeriesLabel: { fontSize: 11, color: colors.textMuted, marginBottom: 4 },

  alarmRow: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 16, paddingVertical: 12 },
  alarmLabel: { fontSize: 14, fontWeight: '500', color: colors.textPrimary },
  alarmDesc: { fontSize: 12, color: colors.textSecondary, marginTop: 2, lineHeight: 16 },
  thresholdInput: {
    width: 64, textAlign: 'right', fontSize: 13, color: colors.textPrimary,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm,
    paddingHorizontal: 8, paddingVertical: 4,
  },

  smallPrimaryBtn: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 5 },
  smallPrimaryBtnText: { fontSize: 12, color: '#fff', fontWeight: '600' },
  mutedText: { fontSize: 13, color: colors.textMuted, lineHeight: 18 },

  testRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, flexWrap: 'wrap' },
  testLabel: { fontSize: 13, fontWeight: '500', color: colors.textPrimary },
  testStatus: { fontSize: 11, fontWeight: '700' },
  testOutputToggle: { fontSize: 12, color: colors.textMuted, marginTop: 6 },
  outputBlock: {
    backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.sm, padding: spacing.sm, maxHeight: 220, marginTop: 4,
  },
  outputText: { fontSize: 10, color: colors.textSecondary, fontFamily: 'Menlo' },

  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusDotSm: { width: 6, height: 6, borderRadius: 3 },
  infraServerName: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  nodeBlock: {
    borderWidth: 1, borderColor: colors.divider, borderRadius: radius.md,
    backgroundColor: colors.background, padding: spacing.sm, marginTop: spacing.sm,
  },
  infraNodeName: { fontSize: 13, fontWeight: '500', color: colors.textPrimary, flexShrink: 1 },
  roleBadge: { borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  roleBadgeManager: { backgroundColor: '#eef2ff' },
  roleBadgeStorage: { backgroundColor: '#ecfdf5' },
  roleBadgeText: { fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  infraDiskLabel: { fontSize: 12, fontWeight: '500', color: colors.textSecondary, flexShrink: 1 },
  infraDiskTemp: { fontSize: 12, fontWeight: '600' },
  unassignedBlock: {
    borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border,
    borderRadius: radius.md, padding: spacing.sm, marginTop: spacing.sm,
  },
  tierBadge: { borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  tierBadgeFast: { backgroundColor: '#ecfdf5' },
  tierBadgeStd: { backgroundColor: colors.divider },
  tierBadgeText: { fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },

  allocBarTrack: { height: 8, backgroundColor: colors.divider, borderRadius: 4, overflow: 'hidden', marginTop: 6 },
  allocBarAlloc: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: colors.primaryLight, borderRadius: 4 },
  allocBarUsed: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: colors.info, borderRadius: 4 },
});
