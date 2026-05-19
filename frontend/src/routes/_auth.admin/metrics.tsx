import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import {
  addDrive,
  createServer,
  driveTempsQueryOptions,
  getMetricsHistoryByHours,
  infrastructureQueryOptions,
  pingServer,
  runTests,
  shutdownServer,
  speedTestQueryOptions,
  triggerSpeedTest,
  updateDrive,
  updateServer,
} from '../../api/admin'
import type { DriveTemp, DriveSummary, TestRunResponse } from '../../api/admin'
import { useMetricsStream } from '../../hooks/useMetricsStream'
import { LineGraph } from '../../components/LineGraph'
import type { LinePoint } from '../../components/LineGraph'
import { useNotification } from '../../context/NotificationContext'

export const Route = createFileRoute('/_auth/admin/metrics')({
  component: RouteComponent,
})

const GB = 1024 ** 3

type HourWindow = 1 | 12 | 24 | 48 | 72
const HOUR_OPTIONS: HourWindow[] = [1, 12, 24, 48, 72]

type MetricKey = 'total_users' | 'active_users' | 'disk' | 'memory' | 'traffic' | 'ping' | 'loss' | 'cpu_temp' | 'drive_temp'

const METRIC_LABELS: Record<MetricKey, string> = {
  total_users:  'Total users',
  active_users: 'Active users',
  disk:         'Disk committed',
  memory:       'Memory',
  traffic:      'Network traffic',
  ping:         'Ping',
  loss:         'Packet loss',
  cpu_temp:     'CPU temperature',
  drive_temp:   'Drive temperature',
}

function formatTempY(v: number): string {
  return `${v.toFixed(1)}°C`
}

function formatCount(v: number): string {
  return v.toFixed(0)
}

function RouteComponent() {
  const { notify } = useNotification()
  const queryClient = useQueryClient()
  const { snapshots, connected } = useMetricsStream()
  const [hours, setHours] = useState<HourWindow>(12)
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('traffic')

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

  const nowMs = Date.now()

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

  const historyCpuTempPoints: LinePoint[] = (historySnaps ?? [])
    .filter(s => s.cpu_temp_celsius != null)
    .map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.cpu_temp_celsius! }))

  const historyDriveTempPoints: LinePoint[] = (historySnaps ?? [])
    .filter(s => s.drive_temp_celsius != null)
    .map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.drive_temp_celsius! }))

  const cpuTempPoints = hours === 1 ? wsCpuTempPoints : historyCpuTempPoints
  const driveTempPoints = hours === 1 ? wsDriveTempPoints : historyDriveTempPoints

  const { pingMs: clientPingMs, packetLossPercent: clientPacketLoss, history: clientPingHistory } = useServerPing()

  // Network rate line points (live — derived from consecutive snapshot diffs)
  const wsNetUploadPoints: LinePoint[] = []
  const wsNetDownloadPoints: LinePoint[] = []
  const recentSnapsForNet = snapshots.filter(s => new Date(s.sampled_at).getTime() >= nowMs - 60 * 60 * 1000)
  for (let i = 1; i < recentSnapsForNet.length; i++) {
    const prev = recentSnapsForNet[i - 1]
    const curr = recentSnapsForNet[i]
    const dtMs = new Date(curr.sampled_at).getTime() - new Date(prev.sampled_at).getTime()
    if (dtMs <= 0) continue
    const sentBps = ((curr.network_bytes_sent - prev.network_bytes_sent) / dtMs) * 1000
    const recvBps = ((curr.network_bytes_recv - prev.network_bytes_recv) / dtMs) * 1000
    if (sentBps < 0 || recvBps < 0) continue
    wsNetUploadPoints.push({ x: new Date(curr.sampled_at).getTime(), y: sentBps })
    wsNetDownloadPoints.push({ x: new Date(curr.sampled_at).getTime(), y: recvBps })
  }
  const wsPingPoints: LinePoint[] = recentSnapsForNet
    .filter(s => s.server_isp_ping_ms != null)
    .map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.server_isp_ping_ms! }))
  const wsLossPoints: LinePoint[] = recentSnapsForNet
    .filter(s => s.server_isp_packet_loss_percent != null)
    .map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.server_isp_packet_loss_percent! }))

  // Network rate line points (history)
  const histNetUploadPoints: LinePoint[] = []
  const histNetDownloadPoints: LinePoint[] = []
  const histSnaps = historySnaps ?? []
  for (let i = 1; i < histSnaps.length; i++) {
    const prev = histSnaps[i - 1]
    const curr = histSnaps[i]
    const dtMs = new Date(curr.sampled_at).getTime() - new Date(prev.sampled_at).getTime()
    if (dtMs <= 0) continue
    const sentBps = ((curr.network_bytes_sent - prev.network_bytes_sent) / dtMs) * 1000
    const recvBps = ((curr.network_bytes_recv - prev.network_bytes_recv) / dtMs) * 1000
    if (sentBps < 0 || recvBps < 0) continue
    histNetUploadPoints.push({ x: new Date(curr.sampled_at).getTime(), y: sentBps })
    histNetDownloadPoints.push({ x: new Date(curr.sampled_at).getTime(), y: recvBps })
  }
  const histPingPoints: LinePoint[] = histSnaps
    .filter(s => s.server_isp_ping_ms != null)
    .map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.server_isp_ping_ms! }))
  const histLossPoints: LinePoint[] = histSnaps
    .filter(s => s.server_isp_packet_loss_percent != null)
    .map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.server_isp_packet_loss_percent! }))

  const netUploadPoints = hours === 1 ? wsNetUploadPoints : histNetUploadPoints
  const netDownloadPoints = hours === 1 ? wsNetDownloadPoints : histNetDownloadPoints
  const serverPingPoints = hours === 1 ? wsPingPoints : histPingPoints
  // Fall back to client HTTP ping history when server ICMP data is unavailable
  const netPingPoints = serverPingPoints.length >= 2 ? serverPingPoints : clientPingHistory
  const netLossPoints = hours === 1 ? wsLossPoints : histLossPoints

  // Additional metric line points (live)
  const wsUsersPoints: LinePoint[] = recentSnapsForNet.map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.total_user_count }))
  const wsActiveUsersPoints: LinePoint[] = recentSnapsForNet.map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.active_user_count }))
  const wsDiskPoints: LinePoint[] = recentSnapsForNet.map(s => ({
    x: new Date(s.sampled_at).getTime(),
    y: (s.disk_total_bytes - s.disk_free_bytes) + Math.max(0, s.storage_total_quota_bytes - s.storage_total_used_bytes),
  }))
  const wsMemoryPoints: LinePoint[] = recentSnapsForNet.map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.memory_used_bytes }))

  // Additional metric line points (history)
  const histUsersPoints: LinePoint[] = histSnaps.map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.total_user_count }))
  const histActiveUsersPoints: LinePoint[] = histSnaps.map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.active_user_count }))
  const histDiskPoints: LinePoint[] = histSnaps.map(s => ({
    x: new Date(s.sampled_at).getTime(),
    y: (s.disk_total_bytes - s.disk_free_bytes) + Math.max(0, s.storage_total_quota_bytes - s.storage_total_used_bytes),
  }))
  const histMemoryPoints: LinePoint[] = histSnaps.map(s => ({ x: new Date(s.sampled_at).getTime(), y: s.memory_used_bytes }))

  const usersPoints = hours === 1 ? wsUsersPoints : histUsersPoints
  const activeUsersPoints = hours === 1 ? wsActiveUsersPoints : histActiveUsersPoints
  const diskPoints = hours === 1 ? wsDiskPoints : histDiskPoints
  const memoryPoints = hours === 1 ? wsMemoryPoints : histMemoryPoints

  const hasCpuTemp = latest?.cpu_temp_celsius != null
  const hasDriveTemp = latest?.drive_temp_celsius != null

  const { data: driveTemps } = useQuery(driveTempsQueryOptions)

  const { data: speedTest, error: speedTestError } = useQuery({
    ...speedTestQueryOptions,
    retry: false,
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
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-900 m-0">System Metrics</h2>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
            connected ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
          }`}>
            {connected ? 'Live' : 'Reconnecting…'}
          </span>
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
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 mb-8">
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
          <StatCard
            label="Memory"
            value={`${(latest.memory_used_bytes / GB).toFixed(2)} GB`}
            sub={`${memPct.toFixed(1)}% of ${(latest.memory_total_bytes / GB).toFixed(1)} GB`}
            selected={selectedMetric === 'memory'}
            onClick={() => setSelectedMetric('memory')}
          />
          {netSentRate !== null && (
            <NetworkTrafficCard
              sent={netSentRate!}
              recv={netRecvRate!}
              selected={selectedMetric === 'traffic'}
              onClick={() => setSelectedMetric('traffic')}
            />
          )}
          <SpeedTestCard result={liveSpeedTest} onRun={() => speedTestMutation.mutate()} pending={speedTestMutation.isPending} />
          {hasCpuTemp && (
            <StatCard
              label="CPU temp"
              value={`${latest.cpu_temp_celsius!.toFixed(1)}°C`}
              selected={selectedMetric === 'cpu_temp'}
              onClick={() => setSelectedMetric('cpu_temp')}
            />
          )}
          {hasDriveTemp && (
            <StatCard
              label="Drive temp"
              value={`${latest.drive_temp_celsius!.toFixed(1)}°C`}
              selected={selectedMetric === 'drive_temp'}
              onClick={() => setSelectedMetric('drive_temp')}
            />
          )}
          {(driveTemps?.length ?? 0) > 0 && (
            <NvmeTempsCard temps={driveTemps!} />
          )}
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
      )}

      <section className="mb-10">
        <div className="flex items-center gap-3 mb-3">
          <h3 className="text-sm font-semibold text-gray-600 m-0">{METRIC_LABELS[selectedMetric]} over time</h3>
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
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-gray-400 mb-2">↑ Upload</div>
                <LineGraph points={netUploadPoints} width={halfGraphW} height={180} color="#3b82f6" formatY={formatBytesPerSec} />
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-2">↓ Download</div>
                <LineGraph points={netDownloadPoints} width={halfGraphW} height={180} color="#10b981" formatY={formatBytesPerSec} />
              </div>
            </div>
          )}
          {selectedMetric === 'ping' && (
            <LineGraph points={netPingPoints} width={graphW} height={200} color="#f59e0b" formatY={(v) => `${v.toFixed(1)} ms`} />
          )}
          {selectedMetric === 'loss' && (
            <LineGraph points={netLossPoints} width={graphW} height={200} color="#ef4444" formatY={(v) => `${v.toFixed(1)}%`} />
          )}
          {selectedMetric === 'total_users' && (
            <LineGraph points={usersPoints} width={graphW} height={200} color="#8b5cf6" formatY={formatCount} />
          )}
          {selectedMetric === 'active_users' && (
            <LineGraph points={activeUsersPoints} width={graphW} height={200} color="#06b6d4" formatY={formatCount} />
          )}
          {selectedMetric === 'disk' && (
            <LineGraph points={diskPoints} width={graphW} height={200} color="#3b82f6" />
          )}
          {selectedMetric === 'memory' && (
            <LineGraph points={memoryPoints} width={graphW} height={200} color="#8b5cf6" />
          )}
          {selectedMetric === 'cpu_temp' && (
            <LineGraph points={cpuTempPoints} width={graphW} height={200} color="#f59e0b" formatY={formatTempY} />
          )}
          {selectedMetric === 'drive_temp' && (
            <LineGraph points={driveTempPoints} width={graphW} height={200} color="#10b981" formatY={formatTempY} />
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

function SpeedTestCard({ result, onRun, pending }: {
  result: SpeedTestResult | undefined
  onRun: () => void
  pending: boolean
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
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

function NvmeTempsCard({ temps }: { temps: DriveTemp[] }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 cursor-default hover:border-gray-300 transition-colors">
      <div className="text-xs text-gray-400 mb-2">NVMe temps</div>
      <div className="flex flex-col gap-1 max-h-28 overflow-y-auto pr-1">
        {temps.map((d) => (
          <div key={d.name} className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-500 truncate" title={d.name}>{d.name}</span>
            <span className={`text-xs font-semibold tabular-nums shrink-0 ${tempColor(d.temp_celsius)}`}>
              {d.temp_celsius.toFixed(1)}°C
            </span>
          </div>
        ))}
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

function useServerPing() {
  const [result, setResult] = useState<{ pingMs: number | null; packetLossPercent: number; history: LinePoint[] }>({
    pingMs: null,
    packetLossPercent: 0,
    history: [],
  })
  const probesRef = useRef<Array<{ t: number; rtt: number | null }>>([])

  useEffect(() => {
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
  }, [])

  return result
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
