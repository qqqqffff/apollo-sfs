import { del, get, patch, post, put } from './client'
import type { AuditLog, BannedIP, Feedback, FeedbackStatus, FavoriteList, Folder, FolderContents, Invitation, InterestSubmission, InterestFormSettings, PageResult, ServerExpansionRequest, User, UserBan } from '../types/api'

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

export function adminGetUserAncestors(username: string, folderId: string) {
  return get<{ ancestors: Folder[] }>(`/admin/users/${encodeURIComponent(username)}/folders/${folderId}/ancestors`)
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

// ── Per-user storage view ────────────────────────────────────────────────────

export interface AdminUserStorageAllocation {
  server_id: string
  server_name: string
  server_state: string
  node_id: string
  node_hostname: string
  drive_id: string
  drive_label: string
  drive_type: 'nvme' | 'hdd'
  capacity_bytes: number
  quota_bytes: number // this user's own slice of the drive, admin-editable
  used_bytes: number
  is_primary: boolean
}

export interface AdminUserStorage {
  quota_bytes: number
  used_bytes: number
  nvme_bytes: number
  hdd_bytes: number
  allocations: AdminUserStorageAllocation[]
  active_request_count: number
}

export function getAdminUserStorage(username: string) {
  return get<AdminUserStorage>(`/admin/users/${encodeURIComponent(username)}/storage`)
}

export interface StorageAllocationInput {
  drive_id: string
  quota_bytes: number
}

export interface StorageAllocationsViolation {
  drive_id: string
  code: 'used_exceeds_quota' | 'insufficient_capacity' | 'removal_blocked'
  used_bytes?: number
  requested_quota_bytes?: number
  max_bytes?: number
  drive_label?: string
}

// updateUserStorageAllocations saves the full desired set of a user's drive
// allocations in one atomic request — see AdminUpdateUserStorageAllocations in
// api/routes/admin_browse.go. A 409 response body's `violations` array uses
// StorageAllocationsViolation's shape.
export function updateUserStorageAllocations(username: string, body: { allocations: StorageAllocationInput[]; reason?: string }) {
  return put<AdminUserStorage>(`/admin/users/${encodeURIComponent(username)}/storage/allocations`, body)
}

// ── Users ──────────────────────────────────────────────────────────────────────

export function listUsers(cursor?: string, limit?: number) {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  if (limit) params.set('limit', String(limit))
  const qs = params.size ? `?${params}` : ''
  return get<PageResult<User>>(`/admin/users${qs}`)
}

export type UserRoleFilter = 'admin' | 'premium' | 'user'
export type UserSortKey = 'username' | 'email' | 'role' | 'created_at' | 'last_seen_at'
export type SortDir = 'asc' | 'desc'

export type StorageTier = 'nvme' | 'hdd'

export interface SearchUsersFilter {
  search?: string
  role?: UserRoleFilter
  sort?: UserSortKey
  dir?: SortDir
  server_id?: string
  tiers?: StorageTier[]
  page?: number
  page_size?: number
}

// searchAdminUsers backs the admin Users table: server-side search, role
// filter, server/tier filter, column sort, and offset pagination — see
// api/routes/admin/users.go SearchUsers. Distinct from
// listUsers/adminUsersInfiniteQueryOptions above, which cursor-page through
// every user unfiltered (used by the alarm subscription user picker).
export function searchAdminUsers(filter: SearchUsersFilter = {}) {
  const params = new URLSearchParams()
  if (filter.search)    params.set('search',    filter.search)
  if (filter.role)      params.set('role',      filter.role)
  if (filter.sort)      params.set('sort',      filter.sort)
  if (filter.dir)       params.set('dir',       filter.dir)
  if (filter.server_id) params.set('server_id', filter.server_id)
  if (filter.tiers)     for (const t of filter.tiers) params.append('tier', t)
  if (filter.page)      params.set('page',      String(filter.page))
  if (filter.page_size) params.set('page_size', String(filter.page_size))
  const qs = params.toString()
  return get<OffsetPage<User>>(`/admin/users/search${qs ? '?' + qs : ''}`)
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

export function updateUserFeedbackAccess(username: string, enabled: boolean) {
  return patch<{ message: string; feedback_access_enabled: boolean }>(
    `/admin/users/${encodeURIComponent(username)}/feedback-access`,
    { enabled },
  )
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
// node's agent and resolved to its registered drive_id. read_bytes/write_bytes
// are cumulative I/O counters (like network_bytes_sent/recv) — diff consecutive
// frames for a bytes/second rate.
export interface DriveFrame {
  drive_id: string
  label: string
  drive_type: 'nvme' | 'hdd'
  temp_celsius: number | null
  total_bytes: number
  used_bytes: number
  free_bytes: number
  read_bytes: number
  write_bytes: number
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
  // Every physical disk the node reports, independent of logical drives — so a
  // single disk in a pooled drive can be tracked (and run hot/fail) on its own.
  disks: DiskFrame[]
}

// DiskFrame is one physical disk's live figures within a node, resolved to its
// node_disks row (disk_id) so per-disk history can be fetched. read_bytes/
// write_bytes are cumulative I/O counters — diff consecutive frames for a
// bytes/second rate.
export interface DiskFrame {
  disk_id: string
  label: string
  device: string
  temp_celsius: number | null
  total_bytes: number
  used_bytes: number
  free_bytes: number
  read_bytes: number
  write_bytes: number
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

// Per-drive read/write I/O history (downsampled), backing the drive-speed
// carousel graph. read_bytes/write_bytes are cumulative counters — diff
// adjacent points for bytes/second, same as network_bytes_sent/recv.
export interface DriveIOSnapshot {
  id: string
  drive_id: string
  read_bytes: number
  write_bytes: number
  sampled_at: string
}

// Per-physical-disk read/write I/O history (downsampled).
export interface NodeDiskIOSnapshot {
  id: string
  disk_id: string
  read_bytes: number
  write_bytes: number
  sampled_at: string
}

// A physical disk's latest reported state (from GET .../nodes/:id/disks).
export interface NodeDisk {
  id: string
  node_id: string
  label: string
  device: string
  capacity_bytes: number
  used_bytes: number
  free_bytes: number
  temp_celsius: number | null
  last_seen_at: string
  created_at: string
}

// Per-physical-disk temperature history (downsampled).
export interface NodeDiskTempSnapshot {
  id: string
  disk_id: string
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

export function getNodeDisks(nodeId: string) {
  return get<NodeDisk[]>(`/admin/system/nodes/${nodeId}/disks`)
}

export function getNodeDiskTempsHistory(diskId: string, hours: number) {
  return get<NodeDiskTempSnapshot[]>(`/admin/system/disks/${diskId}/temps/history?hours=${hours}`)
}

export function getDriveIOHistory(driveId: string, hours: number) {
  return get<DriveIOSnapshot[]>(`/admin/system/drives/${driveId}/io/history?hours=${hours}`)
}

export function getNodeDiskIOHistory(diskId: string, hours: number) {
  return get<NodeDiskIOSnapshot[]>(`/admin/system/disks/${diskId}/io/history?hours=${hours}`)
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
  return get<{ nodes: NodeSummary[]; drives: DriveSummary[]; disks: NodeDisk[] }>('/admin/system/infrastructure')
}

// Rename the top-level cluster server (inline edit on the infrastructure card).
export function renameServer(serverId: string, name: string) {
  return patch<{ message: string }>(`/admin/system/servers/${serverId}`, { name })
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

// ── Feedback review ────────────────────────────────────────────────────────────

export function listFeedback(status?: FeedbackStatus, cursor?: string, limit?: number) {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (cursor) params.set('cursor', cursor)
  if (limit) params.set('limit', String(limit))
  const qs = params.toString()
  return get<PageResult<Feedback>>(`/admin/feedback${qs ? `?${qs}` : ''}`)
}

export function updateFeedbackStatus(id: string, status: FeedbackStatus) {
  return patch<Feedback>(`/admin/feedback/${id}/status`, { status })
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

// ── Drive benchmark ──────────────────────────────────────────────────────────

export interface TierBenchmarkStat {
  seq_write_mbps: number
  seq_read_mbps: number
  random_write_mbps: number
  random_write_iops: number
  random_read_mbps: number
  random_read_iops: number
  disk_count: number
  tested_at: string
}

export interface NodeDiskBenchmarkRow {
  node_id: string
  hostname: string
  label: string
  seq_write_mbps?: number
  seq_read_mbps?: number
  random_write_mbps?: number
  random_write_iops?: number
  random_read_mbps?: number
  random_read_iops?: number
  direct_io: boolean
  size_bytes: number
  error?: string
  tested_at: string
  drive_type: string
}

export interface DriveBenchmarkDetail {
  /** True while a triggered run hasn't been picked up/reported by every node yet. */
  pending: boolean
  /** Active nodes that have reported back since the last trigger (or since always, when nothing is pending). */
  completed_nodes: number
  /** Every active node a triggered run fans out to — a node's whole disk batch arrives in one atomic push, so this is the finest progress granularity available. */
  total_nodes: number
  disks: NodeDiskBenchmarkRow[]
  fast?: TierBenchmarkStat
  standard?: TierBenchmarkStat
}

export function getDriveBenchmark() {
  return get<DriveBenchmarkDetail>('/admin/system/drives/benchmark')
}

export function triggerDriveBenchmark() {
  return post<{ status: string }>('/admin/system/drives/benchmark')
}

export const driveBenchmarkQueryOptions = {
  queryKey: ['admin', 'drive-benchmark'] as const,
  queryFn: getDriveBenchmark,
}

// ── Test runner ────────────────────────────────────────────────────────────────

export interface TestCase {
  name: string
  passed: boolean
  duration_ms?: number
  /** Failure output — only present when passed is false. */
  message?: string
}

export interface CoverageStat {
  lines_pct?: number
  branches_pct?: number
}

export interface SuiteResult {
  passed: boolean
  exit_code: number
  output: string
  duration_ms: number
  num_tests: number
  num_passed: number
  num_failed: number
  /** Per-test breakdown, when the runner sidecar could parse one. */
  tests?: TestCase[]
  /** Absent for suites with no meaningful coverage concept (Playwright E2E). */
  coverage?: CoverageStat
}

export interface TestSuiteEntry {
  enabled: boolean
  result?: SuiteResult
  message?: string
}

export interface TestRunReport {
  backend: TestSuiteEntry
  frontend: TestSuiteEntry
  frontend_e2e: TestSuiteEntry
  mobile: TestSuiteEntry
  recognition: TestSuiteEntry
}

export interface TestRun {
  id: string
  deployment_version: string
  git_branch: string
  report: TestRunReport
  passed: boolean
  created_at: string
}

export interface LatestTestRunResponse {
  /** null when no test run has ever been recorded. */
  run: TestRun | null
  /** false when `run` is a fallback from a different branch (no run yet for current_branch). */
  matched_branch: boolean
  current_branch: string
  current_version: string
}

export function runTests() {
  return post<TestRun>('/admin/system/tests')
}

export function getLatestTestRun() {
  return get<LatestTestRunResponse>('/admin/system/tests/latest')
}

export const latestTestRunQueryOptions = {
  queryKey: ['admin', 'tests', 'latest'] as const,
  queryFn: getLatestTestRun,
}

export interface TestProgressResponse {
  running: boolean
  /** Suite key currently executing (e.g. "frontend_e2e"), absent when nothing is running. */
  current_suite?: string
  /** Execution order of every suite key, so pending ones (not yet in `completed`) can be listed. */
  order?: string[]
  /** Suites that have finished so far, keyed by suite name — same shape as TestRunReport's fields. */
  completed: Record<string, TestSuiteEntry>
}

export function getTestProgress() {
  return get<TestProgressResponse>('/admin/system/tests/progress')
}

// ── Kill switch ────────────────────────────────────────────────────────────────

export function shutdownServer() {
  return post<{ message: string }>('/admin/system/shutdown')
}

// ── Alarm subscriptions ──────────────────────────────────────────────────────

export type AlarmType =
  | 'cpu_usage'
  | 'cpu_temp'
  | 'memory'
  | 'network_traffic'
  | 'drive_temp'
  | 'drive_load'
  | 'api_error_rate'

// AlarmScope is the target dimension each alarm type is configured against.
export type AlarmScope = 'node' | 'drive' | 'cluster'

export const ALARM_SCOPE: Record<AlarmType, AlarmScope> = {
  cpu_usage:       'node',
  cpu_temp:        'node',
  memory:          'node',
  network_traffic: 'node',
  drive_temp:      'drive',
  drive_load:      'drive',
  api_error_rate:  'cluster',
}

// Default thresholds offered when a subscriber first enables an alarm. Mirrors
// the Default*Threshold constants in api/routes/services/alarm.go.
export const ALARM_DEFAULT_THRESHOLD: Record<AlarmType, number> = {
  cpu_usage:       90,
  cpu_temp:        75,
  memory:          90,
  network_traffic: 90,
  drive_temp:      50,
  drive_load:      90,
  api_error_rate:  5,
}

// Unit suffix shown next to a threshold input, by alarm type.
export const ALARM_UNIT: Record<AlarmType, string> = {
  cpu_usage:       '%',
  cpu_temp:        '°C',
  memory:          '%',
  network_traffic: '% of capacity',
  drive_temp:      '°C',
  drive_load:      '% of capacity',
  api_error_rate:  '%',
}

export interface AlarmSubscription {
  id: string
  email: string
  alarm_type: AlarmType
  node_id: string | null
  drive_id: string | null
  threshold: number
  last_fired_at: string | null
  node_hostname?: string
  node_role?: string
  drive_label?: string
  server_name?: string
}

export interface AlarmSubscriptionTarget {
  alarm_type: AlarmType
  node_id?: string | null
  drive_id?: string | null
  threshold?: number
  username?: string
}

export function getAlarmSubscriptions(username?: string) {
  const qs = username ? `?username=${encodeURIComponent(username)}` : ''
  return get<AlarmSubscription[]>(`/admin/system/alarm/subscriptions${qs}`)
}

export function upsertAlarmSubscription(body: AlarmSubscriptionTarget) {
  return put<AlarmSubscription>('/admin/system/alarm/subscriptions', body)
}

export function deleteAlarmSubscription(body: AlarmSubscriptionTarget) {
  return del<{ ok: boolean }>('/admin/system/alarm/subscriptions', body)
}

export function alarmSubscriptionsQueryOptions(username?: string) {
  return {
    queryKey: ['admin', 'alarm', 'subscriptions', username ?? 'self'] as const,
    queryFn: () => getAlarmSubscriptions(username),
  }
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
  is_custom?: boolean
  search?: string
  // "created" (default) | "sla" (nearest deadline first) | "deposit"
  sort?: string
  page?: number
  page_size?: number
}

export interface OffsetPage<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export function listExpansionRequests(filter: ExpansionRequestFilter = {}) {
  const params = new URLSearchParams()
  if (filter.status)    params.set('status',    filter.status)
  if (filter.server_id) params.set('server_id', filter.server_id)
  if (filter.is_custom !== undefined) params.set('is_custom', String(filter.is_custom))
  if (filter.search)    params.set('search',    filter.search)
  if (filter.sort)      params.set('sort',      filter.sort)
  if (filter.page)      params.set('page',      String(filter.page))
  if (filter.page_size) params.set('page_size', String(filter.page_size))
  const qs = params.toString()
  return get<OffsetPage<ServerExpansionRequest>>(`/admin/expansion-requests${qs ? '?' + qs : ''}`)
}

export function approveExpansionRequest(id: string) {
  return post<{ expansion_due_at: string }>(`/admin/expansion-requests/${id}/approve`, {})
}

export function fulfillExpansionRequest(id: string) {
  return post<{ new_quota_bytes: number; remaining_cents: number }>(`/admin/expansion-requests/${id}/fulfill`, {})
}

export function cancelExpansionRequest(id: string, reason: string) {
  return post<{ refund_id: string | null }>(`/admin/expansion-requests/${id}/cancel`, { reason })
}

// ── Custom-request invoices ─────────────────────────────────────────────────────

export interface AdminInvoicePayload {
  line_items: { description: string; amount_cents: number }[]
  deposit_cents: number
  disclosures: string
  notes: string
  include_review_link: boolean
}

export interface AdminExpansionInvoice {
  id: string
  request_id: string
  invoice_number: string
  line_items: { description: string; amount_cents: number }[]
  total_cents: number
  deposit_cents: number
  disclosures: string
  notes: string
  include_review_link: boolean
  status: 'sent' | 'accepted' | 'expired' | 'cancelled'
  sent_at: string
  accept_due_at: string
  accepted_at: string | null
}

export function createExpansionInvoice(id: string, payload: AdminInvoicePayload) {
  return post<AdminExpansionInvoice>(`/admin/expansion-requests/${id}/invoice`, payload)
}

export function getExpansionInvoice(id: string) {
  return get<AdminExpansionInvoice>(`/admin/expansion-requests/${id}/invoice`)
}

// ── Combined orders (premium payments + storage purchases) ─────────────────────

export interface AdminOrder {
  id: string
  type: 'premium' | 'storage'
  username: string
  status: string
  amount_cents: number
  currency: string
  payment_method: string
  reference: string
  invoice_number: string
  created_at: string
  captured_at: string | null
  refund_id: string | null
  refunded_at: string | null
  // Set once the order's local quota/premium grant has been undone via the
  // "Revert allocation" action or the 7-day sandbox auto-revert loop —
  // independent of refunded_at (no PayPal call is made).
  allocation_reverted_at: string | null
  plan_id?: string
  storage_type?: string
  bytes_added?: number
  server_name?: string
  // Which PayPal instance this order was created against — 'sandbox' orders
  // came from an admin's sandbox-payments toggle, not a real customer.
  environment: 'sandbox' | 'live'
}

export function listAdminOrders(opts: { search?: string; sort?: string; page?: number; page_size?: number } = {}) {
  const params = new URLSearchParams()
  if (opts.search)    params.set('search',    opts.search)
  if (opts.sort)      params.set('sort',      opts.sort)
  if (opts.page)      params.set('page',      String(opts.page))
  if (opts.page_size) params.set('page_size', String(opts.page_size))
  const qs = params.toString()
  return get<OffsetPage<AdminOrder>>(`/admin/orders${qs ? '?' + qs : ''}`)
}

// ── Premium subscriptions (admin, all users) ────────────────────────────────────

export interface AdminSubscription {
  id: string
  username: string
  plan: 'monthly' | 'annual'
  status: 'approval_pending' | 'active' | 'suspended' | 'cancelled' | 'expired'
  amount_cents: number
  currency: string
  payment_method: string
  reference: string
  invoice_number: string
  created_at: string
  current_period_end: string | null
  cancelled_at: string | null
  // Which PayPal instance this subscription was created against — 'sandbox'
  // subscriptions came from an admin's sandbox-payments toggle.
  environment: 'sandbox' | 'live'
  // Set only by the admin "Cancel" action's prorated refund — null for
  // subscriptions ended via the user's own self-service cancel (no refund)
  // or a sandbox "Revert" (no PayPal call at all).
  refund_id: string | null
  refund_amount_cents: number | null
  refunded_at: string | null
  // Set only by the admin "Cancel" action — the required reason it was
  // given, also surfaced to the user in their notification bar.
  cancellation_reason: string | null
}

export function listAdminSubscriptions(opts: { search?: string; sort?: string; page?: number; page_size?: number } = {}) {
  const params = new URLSearchParams()
  if (opts.search)    params.set('search',    opts.search)
  if (opts.sort)      params.set('sort',      opts.sort)
  if (opts.page)      params.set('page',      String(opts.page))
  if (opts.page_size) params.set('page_size', String(opts.page_size))
  const qs = params.toString()
  return get<OffsetPage<AdminSubscription>>(`/admin/subscriptions${qs ? '?' + qs : ''}`)
}

export function refundAdminOrder(type: 'premium' | 'storage', id: string) {
  return post<{ refund_id: string }>(`/admin/orders/${type}/${id}/refund`, {})
}

// Cancels an active/suspended subscription on PayPal's side and refunds the
// prorated remainder of its current billing period — stronger than the
// subscriber's own self-service cancel (which stops billing but refunds
// nothing). Works for both live and sandbox subscriptions. reason is
// required — it's shown to the cancelled user in their notification bar
// alongside the refund amount.
export function cancelAdminSubscription(id: string, reason: string) {
  return post<{ refund_id: string | null; refund_amount_cents: number }>(`/admin/subscriptions/${id}/cancel`, { reason })
}

// Reverts a sandbox subscription's local premium grant without a PayPal call
// — the recurring counterpart to revertAdminOrderAllocation. Only available
// for sandbox subscriptions; live subscriptions must use cancelAdminSubscription.
export function revertAdminSubscriptionAllocation(id: string) {
  return post<{ ok: boolean }>(`/admin/subscriptions/${id}/revert-allocation`, {})
}

// Reverts the local quota/premium grant of a captured sandbox order without
// a PayPal refund. Separate from refundAdminOrder — see RevertAllocation
// in api/routes/orders/handler.go for why the two stay independent.
export function revertAdminOrderAllocation(type: 'premium' | 'storage', id: string) {
  return post<{ ok: boolean }>(`/admin/orders/${type}/${id}/revert-allocation`, {})
}
