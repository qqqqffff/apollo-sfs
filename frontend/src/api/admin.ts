import { del, get, patch, post } from './client'
import type { Invitation, PageResult, User } from '../types/api'

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
}

export function getMetrics() {
  return get<MetricsSnapshot>('/admin/system/metrics')
}

export function getMetricsHistoryByHours(hours: number) {
  return get<MetricsSnapshot[]>(`/admin/system/metrics/history?hours=${hours}`)
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
