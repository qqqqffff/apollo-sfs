import { get, post } from './client'

export type StorageType = 'nvme' | 'hdd'

// Fixed plans mirror the iOS app's StorageUpgradeModal pricing exactly.
export interface StoragePlan {
  id: string
  label: string
  addBytes: number
  priceCents: Record<StorageType, number>
}

const GB = 1024 ** 3

export const STORAGE_PLANS: StoragePlan[] = [
  { id: '64gb',  label: '64 GB',  addBytes: 64 * GB,   priceCents: { nvme: 3000,  hdd: 2000 } },
  { id: '128gb', label: '128 GB', addBytes: 128 * GB,  priceCents: { nvme: 5000,  hdd: 3000 } },
  { id: '256gb', label: '256 GB', addBytes: 256 * GB,  priceCents: { nvme: 8000,  hdd: 5000 } },
  { id: '512gb', label: '512 GB', addBytes: 512 * GB,  priceCents: { nvme: 15000, hdd: 8000 } },
  { id: '1tb',   label: '1 TB',   addBytes: 1024 * GB, priceCents: { nvme: 25000, hdd: 12000 } },
]

// Custom capacity (expansion request only, manual review): 1 TiB – 10 PiB,
// priced pro-rata from the 1 TB plan.
export const CUSTOM_PLAN_ID = 'custom'
export const TIB = 1024 * GB
export const CUSTOM_MIN_BYTES = TIB
export const CUSTOM_MAX_BYTES = 10 * 1024 * TIB
export const CUSTOM_PER_TIB_CENTS: Record<StorageType, number> = { nvme: 25000, hdd: 12000 }

export function customPriceCents(bytes: number, storageType: StorageType): number {
  const gib = Math.ceil(bytes / GB)
  return Math.ceil((gib * CUSTOM_PER_TIB_CENTS[storageType]) / 1024)
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

// ── PayPal config ──────────────────────────────────────────────────────────────

export interface BillingConfig {
  paypal_client_id: string
  currency: string
  environment: 'sandbox' | 'live'
}

export function getBillingConfig() {
  return get<BillingConfig>('/billing/config')
}

// ── Direct storage purchases (server-side create + capture) ───────────────────

export interface StorageOrderResult {
  order_id: string
  approval_url: string
}

export function createStorageOrder(planId: string, storageType: StorageType, serverId: string) {
  return post<StorageOrderResult>('/billing/storage/order', {
    plan_id: planId,
    storage_type: storageType,
    server_id: serverId,
  })
}

export function captureStorageOrder(orderId: string) {
  return post<{ new_quota_bytes: number }>(`/billing/storage/order/${orderId}/capture`)
}

// ── Expansion requests (50% deposit; server-side create + capture) ────────────

export interface ExpansionOrderResult {
  order_id: string
  approval_url: string
  deposit_cents: number
  full_price_cents: number
}

export function createExpansionOrder(
  planId: string,
  storageType: StorageType,
  serverId: string,
  customBytes?: number,
) {
  return post<ExpansionOrderResult>('/billing/storage/expansion/order', {
    plan_id: planId,
    storage_type: storageType,
    server_id: serverId,
    ...(customBytes ? { custom_bytes: customBytes } : {}),
  })
}

export function captureExpansionOrder(orderId: string) {
  return post<{ expansion_request_id: string; expires_at: string }>(
    `/billing/storage/expansion/order/${orderId}/capture`,
  )
}

// ── User's expansion request history ──────────────────────────────────────────

export type ExpansionStatus = 'opened' | 'approved' | 'expanded' | 'completed' | 'expired' | 'refunded'

export interface ExpansionRequest {
  id: string
  server_id: string
  server_name: string
  plan_id: string
  storage_type: StorageType
  bytes_requested: number
  deposit_amount_cents: number
  full_price_cents: number
  currency: string
  status: ExpansionStatus
  is_custom: boolean
  expires_at: string
  approval_due_at: string | null
  approved_at: string | null
  expansion_due_at: string | null
  payment_due_at: string | null
  created_at: string
  completed_at: string | null
  cancellation_reason: string | null
}

export async function listMyExpansionRequests(): Promise<ExpansionRequest[]> {
  const res = await get<{ items: ExpansionRequest[] }>('/billing/storage/expansion/requests')
  return res.items ?? []
}

// ── Pay-remaining (after admin marks the capacity expanded) ───────────────────

export function createPayRemainingOrder(requestId: string) {
  return post<{ order_id: string; approval_url: string; remaining_cents: number }>(
    `/billing/storage/expansion/${requestId}/pay-remaining/order`,
  )
}

export function capturePayRemainingOrder(requestId: string, orderId: string) {
  return post<{ new_quota_bytes: number }>(
    `/billing/storage/expansion/${requestId}/pay-remaining/order/${orderId}/capture`,
  )
}
