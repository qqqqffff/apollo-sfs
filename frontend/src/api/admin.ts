import { del, get, patch, post, put } from './client'
import type { BannedIP, Invitation, InterestSubmission, InterestFormSettings, PageResult, User } from '../types/api'

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

export function createInvitation(email: string, initialQuotaBytes: number) {
  return post<Invitation>('/admin/invitations', { email, initial_quota_bytes: initialQuotaBytes })
}

export function revokeInvitation(id: string) {
  return del<{ message: string }>(`/admin/invitations/${id}`)
}

export function resendInvitation(id: string) {
  return post<{ message: string }>(`/admin/invitations/${id}/resend`)
}

// ── Metrics ────────────────────────────────────────────────────────────────────

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
}

export function getMetrics() {
  return get<MetricsSnapshot>('/admin/system/metrics')
}

export function getMetricsHistoryByHours(hours: number) {
  return get<MetricsSnapshot[]>(`/admin/system/metrics/history?hours=${hours}`)
}

export async function pingServer(): Promise<number> {
  const start = performance.now()
  await fetch('/api/v1/admin/system/ping', { signal: AbortSignal.timeout(5000) })
  return performance.now() - start
}

// ── Infrastructure ─────────────────────────────────────────────────────────────

export interface DriveSummary {
  drive_id: string
  server_id: string
  server_name: string
  drive_label: string
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
  return get<{ drives: DriveSummary[] }>('/admin/system/infrastructure')
}

export function getCapacity() {
  return get<CapacitySummary>('/admin/system/capacity')
}

export function createServer(params: {
  state: string
  minio_endpoint: string
  minio_use_ssl: boolean
  access_key: string
  secret_key: string
}) {
  return post<{ id: string; name: string }>('/admin/system/servers', params)
}

export function updateServer(serverId: string, params: { is_active?: boolean }) {
  return patch<{ message: string }>(`/admin/system/servers/${serverId}`, params)
}

export function addDrive(
  serverId: string,
  params: { label: string; minio_bucket: string; capacity_bytes: number },
) {
  return post<DriveSummary>(`/admin/system/servers/${serverId}/drives`, params)
}

export function updateDrive(
  serverId: string,
  driveId: string,
  params: { label?: string; capacity_bytes?: number; is_active?: boolean },
) {
  return patch<DriveSummary>(
    `/admin/system/servers/${serverId}/drives/${driveId}`,
    params,
  )
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

export function provisionInterestSubmission(id: string, initialQuotaBytes: number) {
  return post<Invitation>(`/admin/interest/${id}/provision`, { initial_quota_bytes: initialQuotaBytes })
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

// ── Drive temperatures ─────────────────────────────────────────────────────────

export interface DriveTemp {
  name: string
  temp_celsius: number
}

export function getDriveTemps() {
  return get<DriveTemp[]>('/admin/system/drive-temps')
}

export const driveTempsQueryOptions = {
  queryKey: ['admin', 'drive-temps'] as const,
  queryFn: getDriveTemps,
  staleTime: 10_000,
  refetchInterval: 10_000,
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
