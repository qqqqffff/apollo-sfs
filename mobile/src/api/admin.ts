import api from './client';

// Mirrors frontend/src/api/admin.ts (metrics + infrastructure + alarms only —
// the other admin surfaces are intentionally not ported to mobile).

// ── Metrics ─────────────────────────────────────────────────────────────────

// MetricsSnapshot is the cluster-wide (manager uplink + app) snapshot.
export interface MetricsSnapshot {
  id: string;
  sampled_at: string;
  cpu_percent: number;
  memory_used_bytes: number;
  memory_total_bytes: number;
  network_bytes_sent: number;
  network_bytes_recv: number;
  storage_total_used_bytes: number;
  storage_total_quota_bytes: number;
  disk_total_bytes: number;
  disk_free_bytes: number;
  active_user_count: number;
  total_user_count: number;
  cpu_temp_celsius: number | null;
  drive_temp_celsius: number | null;
  server_isp_ping_ms: number | null;
  server_isp_packet_loss_percent: number | null;
  // Speed test — populated only in WS stream broadcasts, not persisted.
  speed_test_upload_mbps?: number | null;
  speed_test_download_mbps?: number | null;
  speed_test_tested_at?: string | null;
  speed_test_error?: string | null;
}

// DriveFrame is one logical drive's live figures within a node. read_bytes/
// write_bytes are cumulative I/O counters — diff consecutive frames for B/s.
export interface DriveFrame {
  drive_id: string;
  label: string;
  drive_type: 'nvme' | 'hdd';
  temp_celsius: number | null;
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  read_bytes: number;
  write_bytes: number;
}

// DiskFrame is one physical disk's live figures within a node.
export interface DiskFrame {
  disk_id: string;
  label: string;
  device: string;
  temp_celsius: number | null;
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  read_bytes: number;
  write_bytes: number;
}

// NodeFrame is one node's latest hardware state within a MetricsFrame.
export interface NodeFrame {
  node_id: string;
  hostname: string;
  role: string;
  is_active: boolean;
  online: boolean;
  cpu_percent: number;
  cpu_temp_celsius: number | null;
  memory_used_bytes: number;
  memory_total_bytes: number;
  network_bytes_sent: number;
  network_bytes_recv: number;
  sampled_at: string;
  drives: DriveFrame[];
  disks: DiskFrame[];
}

// MetricsFrame is the per-tick WebSocket payload: a cluster snapshot plus a
// per-node hardware breakdown.
export interface MetricsFrame {
  cluster: MetricsSnapshot;
  nodes: NodeFrame[];
}

export interface NodeMetricSnapshot {
  id: string;
  node_id: string;
  cpu_percent: number;
  cpu_temp_celsius: number | null;
  memory_used_bytes: number;
  memory_total_bytes: number;
  network_bytes_sent: number;
  network_bytes_recv: number;
  sampled_at: string;
}

export interface DriveTempSnapshot {
  id: string;
  drive_id: string;
  temp_celsius: number;
  sampled_at: string;
}

export interface IOSnapshot {
  id: string;
  read_bytes: number;
  write_bytes: number;
  sampled_at: string;
}

export async function getMetricsHistoryByHours(hours: number): Promise<MetricsSnapshot[]> {
  const res = await api.get<MetricsSnapshot[]>(`/api/v1/admin/system/metrics/history?hours=${hours}`);
  return res.data ?? [];
}

export async function getNodeMetricsHistory(nodeId: string, hours: number): Promise<NodeMetricSnapshot[]> {
  const res = await api.get<NodeMetricSnapshot[]>(`/api/v1/admin/system/nodes/${nodeId}/metrics/history?hours=${hours}`);
  return res.data ?? [];
}

export async function getDriveTempsHistory(driveId: string, hours: number): Promise<DriveTempSnapshot[]> {
  const res = await api.get<DriveTempSnapshot[]>(`/api/v1/admin/system/drives/${driveId}/temps/history?hours=${hours}`);
  return res.data ?? [];
}

export async function getNodeDiskTempsHistory(diskId: string, hours: number): Promise<DriveTempSnapshot[]> {
  const res = await api.get<DriveTempSnapshot[]>(`/api/v1/admin/system/disks/${diskId}/temps/history?hours=${hours}`);
  return res.data ?? [];
}

export async function getDriveIOHistory(driveId: string, hours: number): Promise<IOSnapshot[]> {
  const res = await api.get<IOSnapshot[]>(`/api/v1/admin/system/drives/${driveId}/io/history?hours=${hours}`);
  return res.data ?? [];
}

export async function getNodeDiskIOHistory(diskId: string, hours: number): Promise<IOSnapshot[]> {
  const res = await api.get<IOSnapshot[]>(`/api/v1/admin/system/disks/${diskId}/io/history?hours=${hours}`);
  return res.data ?? [];
}

export async function pingAdminServer(): Promise<number> {
  const start = Date.now();
  await api.get('/api/v1/admin/system/ping', { timeout: 5000 });
  return Date.now() - start;
}

// ── Infrastructure ──────────────────────────────────────────────────────────

export type NodeRole = 'manager' | 'worker' | 'storage';

export interface NodeSummary {
  node_id: string;
  server_id: string;
  server_name: string;
  server_state: string;
  server_is_active: boolean;
  hostname: string;
  role: NodeRole;
  address: string;
  is_active: boolean;
  created_at: string;
}

export interface DriveSummary {
  drive_id: string;
  server_id: string;
  server_name: string;
  node_id: string | null;
  node_hostname: string;
  node_role: string;
  node_is_active: boolean;
  drive_label: string;
  drive_type: 'nvme' | 'hdd';
  capacity_bytes: number;
  minio_bucket: string;
  allocated_quota_bytes: number;
  used_bytes: number;
  drive_is_active: boolean;
  server_is_active: boolean;
}

export interface NodeDisk {
  id: string;
  node_id: string;
  label: string;
  device: string;
  capacity_bytes: number;
  used_bytes: number;
  free_bytes: number;
  temp_celsius: number | null;
  last_seen_at: string;
  created_at: string;
}

export interface Infrastructure {
  nodes: NodeSummary[];
  drives: DriveSummary[];
  disks: NodeDisk[];
}

export async function listInfrastructure(): Promise<Infrastructure> {
  const res = await api.get<Infrastructure>('/api/v1/admin/system/infrastructure');
  return res.data;
}

export interface DriveStat {
  label: string;
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  temp_celsius: number | null;
  online: boolean;
}

export async function getDriveStats(): Promise<Record<string, DriveStat>> {
  const res = await api.get<{ stats: Record<string, DriveStat> }>('/api/v1/admin/system/drive-stats');
  return res.data.stats ?? {};
}

export interface SyncSummary {
  servers: number;
  nodes: number;
  drives: number;
  pruned: number;
}

// syncInfrastructure indexes the live Docker Swarm and the configured MinIO
// instances, reconciling the servers → nodes → drives topology automatically.
export async function syncInfrastructure(): Promise<SyncSummary> {
  const res = await api.post<SyncSummary>('/api/v1/admin/system/sync');
  return res.data;
}

// ── Speed test ──────────────────────────────────────────────────────────────

export interface SpeedTestResult {
  upload_mbps: number;
  download_mbps: number;
  size_bytes: number;
  tested_at: string;
  error?: string;
}

export async function getSpeedTest(): Promise<SpeedTestResult> {
  const res = await api.get<SpeedTestResult>('/api/v1/admin/system/speed-test');
  return res.data;
}

export async function triggerSpeedTest(): Promise<SpeedTestResult> {
  const res = await api.post<SpeedTestResult>('/api/v1/admin/system/speed-test');
  return res.data;
}

// ── Test runner ─────────────────────────────────────────────────────────────

export interface SuiteResult {
  passed: boolean;
  exit_code: number;
  output: string;
  duration_ms: number;
}

export interface TestSuiteEntry {
  enabled: boolean;
  result?: SuiteResult;
  message?: string;
}

export interface TestRunResponse {
  backend: TestSuiteEntry;
  frontend: TestSuiteEntry;
  frontend_e2e: TestSuiteEntry;
}

export async function runTests(): Promise<TestRunResponse> {
  const res = await api.post<TestRunResponse>('/api/v1/admin/system/tests');
  return res.data;
}

// ── Kill switch ─────────────────────────────────────────────────────────────

export async function shutdownServer(): Promise<void> {
  await api.post('/api/v1/admin/system/shutdown');
}

// ── Alarm subscriptions ─────────────────────────────────────────────────────

export type AlarmType =
  | 'cpu_usage'
  | 'cpu_temp'
  | 'memory'
  | 'network_traffic'
  | 'drive_temp'
  | 'drive_load'
  | 'api_error_rate';

// Default thresholds offered when a subscriber first enables an alarm. Mirrors
// the Default*Threshold constants in api/routes/services/alarm.go.
export const ALARM_DEFAULT_THRESHOLD: Record<AlarmType, number> = {
  cpu_usage: 90,
  cpu_temp: 75,
  memory: 90,
  network_traffic: 90,
  drive_temp: 50,
  drive_load: 90,
  api_error_rate: 5,
};

export const ALARM_UNIT: Record<AlarmType, string> = {
  cpu_usage: '%',
  cpu_temp: '°C',
  memory: '%',
  network_traffic: '% of capacity',
  drive_temp: '°C',
  drive_load: '% of capacity',
  api_error_rate: '%',
};

export interface AlarmSubscription {
  id: string;
  email: string;
  alarm_type: AlarmType;
  node_id: string | null;
  drive_id: string | null;
  threshold: number;
  last_fired_at: string | null;
  node_hostname?: string;
  node_role?: string;
  drive_label?: string;
  server_name?: string;
}

export interface AlarmSubscriptionTarget {
  alarm_type: AlarmType;
  node_id?: string | null;
  drive_id?: string | null;
  threshold?: number;
}

export async function getAlarmSubscriptions(): Promise<AlarmSubscription[]> {
  const res = await api.get<AlarmSubscription[]>('/api/v1/admin/system/alarm/subscriptions');
  return res.data ?? [];
}

export async function upsertAlarmSubscription(body: AlarmSubscriptionTarget): Promise<AlarmSubscription> {
  const res = await api.put<AlarmSubscription>('/api/v1/admin/system/alarm/subscriptions', body);
  return res.data;
}

export async function deleteAlarmSubscription(body: AlarmSubscriptionTarget): Promise<void> {
  await api.delete('/api/v1/admin/system/alarm/subscriptions', { data: body });
}

// ── Sandbox order/subscription reverts ──────────────────────────────────────

// Reverts the local quota/premium grant of a captured sandbox order without a
// PayPal refund — see RevertAllocation in api/routes/orders/handler.go.
export async function revertAdminOrderAllocation(type: 'premium' | 'storage', id: string): Promise<void> {
  await api.post(`/api/v1/admin/orders/${type}/${id}/revert-allocation`, {});
}
