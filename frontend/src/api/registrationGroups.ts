import { del, get, post } from './client'
import type { PageResult } from '../types/api'

// ── Types ──────────────────────────────────────────────────────────────────────

export type SlotDriveType = 'nvme' | 'hdd'
export type SlotAccountStatus = 'base' | 'premium'

// A group of identical registration slots (same server, tier, capacity,
// account status, premium expiry) with per-status counts. slot_id is a
// representative slot of the type — hand it to reserveGroupSlot as-is.
export interface RegistrationSlotType {
  slot_id: string
  server_id: string
  server_name: string
  drive_type: SlotDriveType
  quota_bytes: number
  account_status: SlotAccountStatus
  premium_expires_at?: string | null
  total: number
  consumed: number
  reserved: number
  available: number
}

export interface RegistrationGroupSummary {
  id: string
  created_by_user_id: string
  name: string
  link_id: string
  expires_at: string | null
  is_active: boolean
  notify_emails: string[]
  send_expiry_reminder: boolean
  reminder_sent_at: string | null
  created_at: string
  slots_total: number
  slots_consumed: number
  slots_reserved: number
  group_invite_url: string
}

export interface RegistrationGroupDetail extends RegistrationGroupSummary {
  slot_types: RegistrationSlotType[]
}

export interface RegistrationSlotSpecInput {
  server_id: string
  drive_type: SlotDriveType
  quota_bytes: number
  account_status: SlotAccountStatus
  premium_expires_at?: string
  count: number
}

export interface CreateRegistrationGroupBody {
  name: string
  expires_at?: string
  notify_emails: string[]
  send_expiry_reminder: boolean
  slots: RegistrationSlotSpecInput[]
}

// Per (server, tier) how much space a new slot could still reserve — after
// user allocations and existing slot reservations.
export interface ServerTierAvailability {
  server_id: string
  server_name: string
  drive_type: SlotDriveType
  available_bytes: number
}

// ── Admin endpoints ────────────────────────────────────────────────────────────

export function listRegistrationGroups(cursor?: string) {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  const qs = params.size ? `?${params}` : ''
  return get<PageResult<RegistrationGroupSummary>>(`/admin/registration-groups${qs}`)
}

export function createRegistrationGroup(body: CreateRegistrationGroupBody) {
  return post<RegistrationGroupDetail>('/admin/registration-groups', body)
}

export function getRegistrationGroup(id: string) {
  return get<RegistrationGroupDetail>(`/admin/registration-groups/${id}`)
}

export function deactivateRegistrationGroup(id: string) {
  return post<{ message: string }>(`/admin/registration-groups/${id}/deactivate`)
}

export function deleteRegistrationGroup(id: string) {
  return del<{ message: string }>(`/admin/registration-groups/${id}`)
}

export function getRegistrationCapacity() {
  return get<{ tiers: ServerTierAvailability[] }>('/admin/registration-groups/capacity')
}

export const registrationGroupsInfiniteQueryOptions = {
  queryKey: ['admin', 'registration-groups'] as const,
  queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
    listRegistrationGroups(pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (lastPage: PageResult<RegistrationGroupSummary>) =>
    lastPage.next_token || undefined,
}

export const registrationCapacityQueryOptions = {
  queryKey: ['admin', 'registration-groups', 'capacity'] as const,
  queryFn: getRegistrationCapacity,
  refetchInterval: 30_000,
}

// ── Public group-invite endpoints ──────────────────────────────────────────────

export interface PublicGroupInvite {
  name: string
  link_id: string
  expires_at?: string | null
  slot_types: RegistrationSlotType[]
}

export function getGroupInvite(linkId: string) {
  return get<PublicGroupInvite>(`/group-invites/${encodeURIComponent(linkId)}`)
}

export function reserveGroupSlot(linkId: string, slotId: string) {
  return post<{ reservation_token: string; expires_at: string }>(
    `/group-invites/${encodeURIComponent(linkId)}/reservations`,
    { slot_id: slotId },
  )
}

export interface SlotReservationValidation {
  status: 'active' | 'expired' | 'completed'
  expires_at: string
  group_name: string
  group_link_id: string
  server_name: string
  drive_type: SlotDriveType
  quota_bytes: number
  account_status: SlotAccountStatus
  premium_expires_at?: string | null
}

export function getSlotReservation(token: string) {
  return get<SlotReservationValidation>(`/group-invites/reservations/${encodeURIComponent(token)}`)
}

export function releaseSlotReservation(token: string) {
  return del<{ message: string }>(`/group-invites/reservations/${encodeURIComponent(token)}`)
}

export function checkEmail(email: string) {
  return post<{ valid: boolean; available: boolean }>('/auth/check-email', { email })
}
