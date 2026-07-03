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

// Custom capacity (expansion request only, manual review): above the 1 TB
// plan up to 10 PiB. The price shown at submission is an ESTIMATE, extended
// pro-rata from the 1 TB plan; the final amount is invoiced after the
// 3-business-day review.
export const CUSTOM_PLAN_ID = 'custom'
export const TIB = 1024 * GB
export const CUSTOM_MIN_BYTES = TIB
export const CUSTOM_MAX_BYTES = 10 * 1024 * TIB
export const CUSTOM_PER_TIB_CENTS: Record<StorageType, number> = { nvme: 25000, hdd: 12000 }

export function customPriceCents(bytes: number, storageType: StorageType): number {
  const gib = Math.ceil(bytes / GB)
  return Math.ceil((gib * CUSTOM_PER_TIB_CENTS[storageType]) / 1024)
}

// Custom slider ladder (TiB): 1 TB steps to 32 TB, 4 TB steps to 160 TB,
// 16 TB steps to 512 TB, 64 TB steps to 2 PB, then 256 TB steps to 10 PB.
export function buildCustomTibStops(): number[] {
  const stops: number[] = []
  for (let t = 2; t <= 32; t += 1) stops.push(t)
  for (let t = 36; t <= 160; t += 4) stops.push(t)
  for (let t = 176; t <= 512; t += 16) stops.push(t)
  for (let t = 576; t <= 2048; t += 64) stops.push(t)
  for (let t = 2304; t <= 10240; t += 256) stops.push(t)
  return stops
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

// ── Custom capacity requests (no payment; invoiced after manual review) ───────

export function submitCustomRequest(storageType: StorageType, serverId: string, customBytes: number) {
  return post<{ expansion_request_id: string; review_due_at: string; estimated_price_cents: number }>(
    '/billing/storage/expansion/custom',
    { storage_type: storageType, server_id: serverId, custom_bytes: customBytes },
  )
}

// ── Custom-capacity invoices (review & acceptance) ────────────────────────────

export interface InvoiceLineItem {
  description: string
  amount_cents: number
}

export interface ExpansionInvoice {
  id: string
  request_id: string
  invoice_number: string
  line_items: InvoiceLineItem[]
  total_cents: number
  deposit_cents: number
  disclosures: string
  notes: string
  include_review_link: boolean
  status: 'sent' | 'accepted' | 'expired' | 'cancelled'
  sent_at: string
  accept_due_at: string
  accepted_at: string | null
  created_at: string
}

export function getInvoiceByToken(token: string) {
  return get<{ invoice: ExpansionInvoice; request: ExpansionRequest }>(`/billing/invoices/${token}`)
}

export function acceptInvoice(token: string) {
  return post<{ status: string }>(`/billing/invoices/${token}/accept`)
}

export function declineInvoice(token: string) {
  return post<{ status: string }>(`/billing/invoices/${token}/decline`)
}

export function createInvoiceDepositOrder(token: string) {
  return post<{ order_id: string; approval_url: string; deposit_cents: number }>(
    `/billing/invoices/${token}/order`,
  )
}

export function captureInvoiceDepositOrder(token: string, orderId: string) {
  return post<{ status: string }>(`/billing/invoices/${token}/order/${orderId}/capture`)
}

// ── User's expansion request history ──────────────────────────────────────────

export type ExpansionStatus =
  | 'opened' | 'invoice_sent' | 'accepted' | 'approved' | 'expanded'
  | 'completed' | 'expired' | 'refunded' | 'rejected'

export interface ExpansionRequest {
  id: string
  username: string
  server_id: string
  server_name: string
  plan_id: string
  storage_type: StorageType
  bytes_requested: number
  deposit_amount_cents: number
  full_price_cents: number
  currency: string
  payment_method: string
  status: ExpansionStatus
  is_custom: boolean
  expires_at: string
  approval_due_at: string | null
  approved_at: string | null
  expansion_due_at: string | null
  payment_due_at: string | null
  reminder_sent_at: string | null
  created_at: string
  completed_at: string | null
  cancellation_reason: string | null
  paypal_capture_id: string | null
  // Latest invoice summary (admin listing, custom requests only).
  invoice_number?: string
  invoice_status?: string
  invoice_sent_at?: string
  invoice_accept_due_at?: string
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
