import { del, get, patch, post, put } from './client'
import type { AuditLog, BannedIP, FavoriteList, FolderContents, Invitation, InterestSubmission, InterestFormSettings, PageResult, ServerExpansionRequest, User, UserBan } from '../types/api'

// ── Admin user file browsing ───────────────────────────────────────────────────

interface AdminFolderParams {
  folderCursor?: string
  fileCursor?: string
  folderLimit?: number
  fileLimit?: number
}

function adminFolderQS(p: AdminFolderParams): string {
  const params = new URLSearchParams()
  if (p.folderCursor) params.set('folder_cursor', p.folderCursor)
  if (p.fileCursor) params.set('file_cursor', p.fileCursor)
  if (p.folderLimit !== undefined) params.set('folder_limit', String(p.folderLimit))
  if (p.fileLimit !== undefined) params.set('file_limit', String(p.fileLimit))
  return params.size ? `?${params}` : ''
}

export function adminListUserRoot(username: string, p: AdminFolderParams = {}) {
  return get<FolderContents>(`/admin/users/${encodeURIComponent(username)}/folders${adminFolderQS(p)}`)
}

export function adminGetUserFolder(username: string, folderId: string, p: AdminFolderParams = {}) {
  return get<FolderContents>(`/admin/users/${encodeURIComponent(username)}/folders/${folderId}${adminFolderQS(p)}`)
}

export function adminGetUserFavorites(username: string) {
  return get<FavoriteList>(`/admin/users/${encodeURIComponent(username)}/favorites`)
}

export function getAdminAuditLogs(username: string, cursor?: string) {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  const qs = params.size ? `?${params}` : ''
  return get<PageResult<AuditLog>>(`/admin/users/${encodeURIComponent(username)}/audit-logs${qs}`)
}

export function logImpersonationAccess(username: string) {
  return post<{ ok: boolean }>(`/admin/users/${encodeURIComponent(username)}/audit-logs`, {})
}

// ── Users ──────────────────────────────────────────────────────────────────────

export function listUsers(cursor?: string, limit?: number) {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  if (limit) params.set('limit', String(limit))
  const qs = params.size ? `?${params}` : ''
  return get<PageResult<User>>(`/admin/users${qs}`)
}

export function getUser(username: string) {
  return get<User>(`/admin/users/${username}`)
}

export function updateUserQuota(username: string, quota_bytes: number) {
  return patch<{ message: string }>(`/admin/users/${username}/quota`, { quota_bytes })
}

export function updateUsername(username: string, newUsername: string) {
  return patch<{ message: string }>(`/admin/users/${username}/username`, { new_username: newUsername })
}

// ── Invitations ────────────────────────────────────────────────────────────────

export function listInvitations(cursor?: string) {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  const qs = params.size ? `?${params}` : ''
  return get<PageResult<Invitation>>(`/admin/invitations${qs}`)
}

export function createInvitation(email: string, initialQuotaBytes: number, grantAdmin = false, grantPremium = false, initialDriveId?: string) {
  return post<Invitation>('/admin/invitations', {
    email,
    initial_quota_bytes: initialQuotaBytes,
    grant_admin: grantAdmin,
    grant_premium: grantPremium,
    ...(initialDriveId ? { initial_drive_id: initialDriveId } : {}),
  })
}

export function revokeInvitation(id: string) {
  return del<{ message: string }>(`/admin/invitations/${id}`)
}

export function resendInvitation(id: string) {
  return post<{ message: string }>(`/admin/invitations/${id}/resend`)
}

// ── Metrics ────────────────────────────────────────────────────────────────────

// MetricsSnapshot is the cluster-wide (manager uplink + app) snapshot. Hardware
// fields (cpu_*, drive_temp) remain for backward compatibility but the per-node
// view sources hardware from NodeFrame instead — see MetricsFrame.
export interface MetricsSnapshot {
  id: string
  sampled_at: string
  cpu_percent: number
  memory_used_bytes: number
  memory_total_bytes: number
  network_bytes_sent: number
  network_bytes_recv: number
  storage_total_used_bytes: number
  storage_total_quota_bytes: number
  disk_total_bytes: number
  disk_free_bytes: number
  active_user_count: number
  total_user_count: number
  cpu_temp_celsius: number | null
  drive_temp_celsius: number | null
  server_isp_ping_ms: number | null
  server_isp_packet_loss_percent: number | null
  // Speed test — populated only in WS stream broadcasts, not persisted.
  speed_test_upload_mbps?: number | null
  speed_test_download_mbps?: number | null
  speed_test_tested_at?: string | null
  speed_test_error?: string | null
}

// DriveFrame is one drive's live figures within a node, as reported by that
// node's agent and resolved to its registered drive_id.
export interface DriveFrame {
  drive_id: string
  label: string
  drive_type: 'nvme' | 'hdd'
  temp_celsius: number | null
  total_bytes: number
  used_bytes: number
  free_bytes: number
}

// NodeFrame is one node's latest hardware state within a MetricsFrame. online is
// false when the node's agent has stopped reporting (the UI then greys it out).
export interface NodeFrame {
  node_id: string
  hostname: string
  role: string
  is_active: boolean
  online: boolean
  cpu_percent: number
  cpu_temp_celsius: number | null
  memory_used_bytes: number
  memory_total_bytes: number
  network_bytes_sent: number
  network_bytes_recv: number
  sampled_at: string
  drives: DriveFrame[]
}

// MetricsFrame is the per-tick WebSocket payload: a cluster snapshot plus a
// per-node hardware breakdown. Seed (historical) frames carry an empty nodes list.
export interface MetricsFrame {
  cluster: MetricsSnapshot
  nodes: NodeFrame[]
}

// Per-node hardware history (downsampled), backing the per-node line graphs.
export interface NodeMetricSnapshot {
  id: string
  node_id: string
  cpu_percent: number
  cpu_temp_celsius: number | null
  memory_used_bytes: number
  memory_total_bytes: number
  network_bytes_sent: number
  network_bytes_recv: number
  sampled_at: string
}

// Per-drive temperature history (downsampled), backing the carousel graph.
export interface DriveTempSnapshot {
  id: string
  drive_id: string
  temp_celsius: number
  sampled_at: string
}

export function getMetrics() {
  return get<MetricsSnapshot>('/admin/system/metrics')
}

export function getMetricsHistoryByHours(hours: number) {
  return get<MetricsSnapshot[]>(`/admin/system/metrics/history?hours=${hours}`)
}

export function getNodeMetricsHistory(nodeId: string, hours: number) {
  return get<NodeMetricSnapshot[]>(`/admin/system/nodes/${nodeId}/metrics/history?hours=${hours}`)
}

export function getDriveTempsHistory(driveId: string, hours: number) {
  return get<DriveTempSnapshot[]>(`/admin/system/drives/${driveId}/temps/history?hours=${hours}`)
}

export async function pingServer(): Promise<number> {
  const start = performance.now()
  await fetch('/api/v1/admin/system/ping', { signal: AbortSignal.timeout(5000) })
  return performance.now() - start
}

// ── Infrastructure ─────────────────────────────────────────────────────────────

export type NodeRole = 'manager' | 'worker' | 'storage'

export interface NodeSummary {
  node_id: string
  server_id: string
  server_name: string
  server_state: string
  server_is_active: boolean
  hostname: string
  role: NodeRole
  address: string
  is_active: boolean
  created_at: string
}

export interface DriveSummary {
  drive_id: string
  server_id: string
  server_name: string
  node_id: string | null
  node_hostname: string
  node_role: string
  node_is_active: boolean
  drive_label: string
  drive_type: 'nvme' | 'hdd'
  capacity_bytes: number
  minio_bucket: string
  allocated_quota_bytes: number
  used_bytes: number
  drive_is_active: boolean
  server_is_active: boolean
}

export interface CapacitySummary {
  max_available_bytes: number
}

export function listInfrastructure() {
  return get<{ nodes: NodeSummary[]; drives: DriveSummary[] }>('/admin/system/infrastructure')
}

// Live, per-drive view sourced from the owning node's agent push (keyed by
// drive_id). online=false means no online node currently reports the drive (e.g.
// the node is offline), in which case the UI falls back to stored DB capacity.
export interface DriveStat {
  label: string
  total_bytes: number
  used_bytes: number
  free_bytes: number
  temp_celsius: number | null
  online: boolean
}

export function getDriveStats() {
  return get<{ stats: Record<string, DriveStat> }>('/admin/system/drive-stats')
}

export const driveStatsQueryOptions = {
  queryKey: ['admin', 'drive-stats'] as const,
  queryFn: getDriveStats,
  staleTime: 10_000,
  refetchInterval: 10_000,
}

export function getCapacity() {
  return get<CapacitySummary>('/admin/system/capacity')
}

// SyncSummary reports what the universal infrastructure sync indexed: the count
// of servers, swarm nodes, and drives reconciled, plus how many stale rows were
// retired (marked inactive).
export interface SyncSummary {
  servers: number
  nodes: number
  drives: number
  pruned: number
}

// syncInfrastructure indexes the live Docker Swarm and the configured MinIO
// instances, reconciling the servers → nodes → drives topology automatically
// (manager/worker roles, drive capacity, fast/standard classification). It is
// idempotent and replaces the former manual add/edit/remove controls.
export function syncInfrastructure() {
  return post<SyncSummary>('/admin/system/sync')
}

export const infrastructureQueryOptions = {
  queryKey: ['admin', 'infrastructure'] as const,
  queryFn: listInfrastructure,
  refetchInterval: 30_000,
}

export const capacityQueryOptions = {
  queryKey: ['admin', 'capacity'] as const,
  queryFn: getCapacity,
  refetchInterval: 30_000,
}

// ── Banned IPs ─────────────────────────────────────────────────────────────────

export type BanStatus = 'active' | 'all'

export function listBannedIPs(status: BanStatus, cursor?: string, limit?: number) {
  const params = new URLSearchParams({ status })
  if (cursor) params.set('cursor', cursor)
  if (limit) params.set('limit', String(limit))
  return get<PageResult<BannedIP>>(`/admin/banned-ips?${params}`)
}

export function unbanIP(id: number) {
  return post<{ message: string }>(`/admin/banned-ips/${id}/unban`)
}

export function extendBan(id: number) {
  return post<{ message: string }>(`/admin/banned-ips/${id}/extend`)
}

// ── User bans / suspensions ────────────────────────────────────────────────────

export function banUser(username: string, violationCode: string, comments: string) {
  return post<{ message: string }>(`/admin/users/${encodeURIComponent(username)}/ban`, {
    violation_code: violationCode,
    comments,
  })
}

export function suspendUser(username: string, violationCode: string, comments: string, hours: number) {
  return post<{ message: string }>(`/admin/users/${encodeURIComponent(username)}/suspend`, {
    violation_code: violationCode,
    comments,
    hours,
  })
}

export function pardonUser(username: string) {
  return post<{ message: string }>(`/admin/users/${encodeURIComponent(username)}/pardon`)
}

export function listUserBans(status: BanStatus, cursor?: string, limit?: number) {
  const params = new URLSearchParams({ status })
  if (cursor) params.set('cursor', cursor)
  if (limit) params.set('limit', String(limit))
  return get<PageResult<UserBan>>(`/admin/bans?${params}`)
}

export const adminUserBansInfiniteQueryOptions = {
  queryKey: ['admin', 'bans'] as const,
  queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
    listUserBans('active', pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (lastPage: PageResult<UserBan>) =>
    lastPage.next_token || undefined,
}

// ── Interest form ──────────────────────────────────────────────────────────────

export function listInterestSubmissions(cursor?: string) {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  const qs = params.size ? `?${params}` : ''
  return get<PageResult<InterestSubmission>>(`/admin/interest${qs}`)
}

export function getInterestFormSettings() {
  return get<InterestFormSettings>('/admin/interest/settings')
}

export function updateInterestFormSettings(dailyCap: number) {
  return put<InterestFormSettings>('/admin/interest/settings', { daily_cap: dailyCap })
}

export function provisionInterestSubmission(id: string, initialQuotaBytes: number, grantAdmin = false) {
  return post<Invitation>(`/admin/interest/${id}/provision`, { initial_quota_bytes: initialQuotaBytes, grant_admin: grantAdmin })
}

export const adminInterestInfiniteQueryOptions = {
  queryKey: ['admin', 'interest'] as const,
  queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
    listInterestSubmissions(pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (lastPage: PageResult<InterestSubmission>) =>
    lastPage.next_token || undefined,
}

export const interestFormSettingsQueryOptions = {
  queryKey: ['admin', 'interest', 'settings'] as const,
  queryFn: getInterestFormSettings,
}

// ── Speed test ─────────────────────────────────────────────────────────────────

export interface SpeedTestResult {
  upload_mbps: number
  download_mbps: number
  size_bytes: number
  tested_at: string
  error?: string
}

export function getSpeedTest() {
  return get<SpeedTestResult>('/admin/system/speed-test')
}

export function triggerSpeedTest() {
  return post<SpeedTestResult>('/admin/system/speed-test')
}

export const speedTestQueryOptions = {
  queryKey: ['admin', 'speed-test'] as const,
  queryFn: getSpeedTest,
}

// ── Test runner ────────────────────────────────────────────────────────────────

export interface SuiteResult {
  passed: boolean
  exit_code: number
  output: string
  duration_ms: number
}

export interface TestSuiteEntry {
  enabled: boolean
  result?: SuiteResult
  message?: string
}

export interface TestRunResponse {
  backend: TestSuiteEntry
  frontend: TestSuiteEntry
  frontend_e2e: TestSuiteEntry
}

export function runTests() {
  return post<TestRunResponse>('/admin/system/tests')
}

// ── Kill switch ────────────────────────────────────────────────────────────────

export function shutdownServer() {
  return post<{ message: string }>('/admin/system/shutdown')
}

// ── Alarm settings ─────────────────────────────────────────────────────────────

export type AlarmType =
  | 'cpu_usage'
  | 'cpu_temp'
  | 'drive_temp'
  | 'drive_load'
  | 'network_traffic'
  | 'api_error_rate'

export interface AlarmSettings {
  cpu_usage_emails: string[]
  cpu_usage_last_fired_at: string | null
  cpu_temp_emails: string[]
  cpu_temp_last_fired_at: string | null
  drive_temp_emails: string[]
  drive_temp_last_fired_at: string | null
  drive_load_emails: string[]
  drive_load_last_fired_at: string | null
  network_traffic_emails: string[]
  network_traffic_last_fired_at: string | null
  api_error_rate_emails: string[]
  api_error_rate_last_fired_at: string | null
  updated_at: string
}

export function getAlarmSettings() {
  return get<AlarmSettings>('/admin/system/alarm/settings')
}

export function toggleAlarmSubscription(alarmType: AlarmType, subscribed: boolean) {
  return post<AlarmSettings>('/admin/system/alarm/subscribe', { alarm_type: alarmType, subscribed })
}

export const alarmSettingsQueryOptions = {
  queryKey: ['admin', 'alarm', 'settings'] as const,
  queryFn: getAlarmSettings,
}

// ── Query options ──────────────────────────────────────────────────────────────

export const adminUsersInfiniteQueryOptions = {
  queryKey: ['admin', 'users'] as const,
  queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
    listUsers(pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (lastPage: PageResult<User>) =>
    lastPage.next_token || undefined,
}

export const adminInvitationsInfiniteQueryOptions = {
  queryKey: ['admin', 'invitations'] as const,
  queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
    listInvitations(pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (lastPage: PageResult<Invitation>) =>
    lastPage.next_token || undefined,
}

export const adminMetricsQueryOptions = {
  queryKey: ['admin', 'metrics'] as const,
  queryFn: getMetrics,
  refetchInterval: 10_000,
}

// ── Expansion requests ─────────────────────────────────────────────────────────

export interface ExpansionRequestFilter {
  status?: string
  server_id?: string
  from?: string
  to?: string
  cursor?: string
}

export function listExpansionRequests(filter: ExpansionRequestFilter = {}) {
  const params = new URLSearchParams()
  if (filter.status)    params.set('status',    filter.status)
  if (filter.server_id) params.set('server_id', filter.server_id)
  if (filter.from)      params.set('from',       filter.from)
  if (filter.to)        params.set('to',         filter.to)
  if (filter.cursor)    params.set('cursor',     filter.cursor)
  const qs = params.toString()
  return get<PageResult<ServerExpansionRequest>>(`/admin/expansion-requests${qs ? '?' + qs : ''}`)
}

export function fulfillExpansionRequest(id: string) {
  return post<{ new_quota_bytes: number }>(`/admin/expansion-requests/${id}/fulfill`, {})
}

export function cancelExpansionRequest(id: string, reason: string) {
  return post<{ refund_id: string }>(`/admin/expansion-requests/${id}/cancel`, { reason })
}

export const expansionRequestsQueryOptions = (filter: ExpansionRequestFilter = {}) => ({
  queryKey: ['admin', 'expansion-requests', filter] as const,
  queryFn: () => listExpansionRequests(filter),
})
