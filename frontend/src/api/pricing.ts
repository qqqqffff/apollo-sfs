import { del, get, patch, post } from './client'
import type { StorageType } from './billing'

// ── Types ──────────────────────────────────────────────────────────────────────

// PricingItem is one purchasable storage line item on a server tier, as
// managed on the admin pricing page.
export interface PricingItem {
  id: string
  server_id: string
  storage_type: StorageType
  bytes: number
  price_cents: number
  sort_order: number
  created_at: string
  updated_at: string
}

export type DiscountScope = 'server' | 'tier' | 'item'
export type DiscountMode = 'percent' | 'price'
export type NotifyGroup = 'all' | 'server' | 'server_tier'

// PricingDiscount is an admin-created markdown of one pricing target. Only
// one exists per exact target; the most specific scope wins per item.
export interface PricingDiscount {
  id: string
  scope: DiscountScope
  server_id: string
  storage_type?: StorageType
  item_id?: string
  mode: DiscountMode
  percent_off?: number
  price_cents?: number
  premium_only: boolean
  expires_at?: string
  notify_group?: NotifyGroup
  created_by: string
  created_at: string
}

// PricingServer is a row of the admin page's server picker.
export interface PricingServer {
  id: string
  name: string
  is_active: boolean
  tiers: StorageType[]
}

// ── Client-side effective price helpers (mirror models/pricing.go) ─────────────

const scopeRank: Record<DiscountScope, number> = { item: 0, tier: 1, server: 2 }

export function discountAppliesTo(d: PricingDiscount, item: PricingItem): boolean {
  if (d.scope === 'item') return d.item_id === item.id
  if (d.scope === 'tier') return d.server_id === item.server_id && d.storage_type === item.storage_type
  return d.server_id === item.server_id
}

export function discountActive(d: PricingDiscount, now = new Date()): boolean {
  return !d.expires_at || new Date(d.expires_at) > now
}

// resolveDiscount picks the most specific active discount for an item —
// item > tier > server, never stacking.
export function resolveDiscount(
  item: PricingItem,
  discounts: PricingDiscount[],
  now = new Date(),
): PricingDiscount | undefined {
  let best: PricingDiscount | undefined
  for (const d of discounts) {
    if (!discountActive(d, now) || !discountAppliesTo(d, item)) continue
    if (!best || scopeRank[d.scope] < scopeRank[best.scope]) best = d
  }
  return best
}

// discountedCents applies a discount to a base price: percent rounds half-up,
// reduced price clamps to the base so it can never mark an item up.
export function discountedCents(d: PricingDiscount, baseCents: number): number {
  if (d.mode === 'percent') {
    return Math.floor((baseCents * (100 - (d.percent_off ?? 0)) + 50) / 100)
  }
  return Math.min(d.price_cents ?? baseCents, baseCents)
}

// discountPercentFor is the badge percentage: the stored percent, or the
// per-item deduction derived from a reduced price.
export function discountPercentFor(d: PricingDiscount, baseCents: number): number {
  if (d.mode === 'percent') return d.percent_off ?? 0
  if (baseCents <= 0) return 0
  const off = baseCents - discountedCents(d, baseCents)
  return Math.round((off * 100) / baseCents)
}

// ── Admin endpoints ─────────────────────────────────────────────────────────────

export async function listPricingServers(): Promise<PricingServer[]> {
  const res = await get<{ servers: PricingServer[] }>('/admin/pricing/servers')
  return res.servers ?? []
}

export interface ServerPricing {
  items: PricingItem[]
  discounts: PricingDiscount[]
}

export function getServerPricing(serverId: string) {
  return get<ServerPricing>(`/admin/pricing?server_id=${encodeURIComponent(serverId)}`)
}

export function createPricingItem(input: {
  server_id: string
  storage_type: StorageType
  bytes: number
  price_cents: number
  sort_order?: number
}) {
  return post<{ item: PricingItem }>('/admin/pricing/items', input)
}

export function updatePricingItem(
  itemId: string,
  input: { bytes: number; price_cents: number; sort_order: number },
) {
  return patch<{ item: PricingItem }>(`/admin/pricing/items/${itemId}`, input)
}

export function deletePricingItem(itemId: string) {
  return del<void>(`/admin/pricing/items/${itemId}`)
}

export interface CreateDiscountInput {
  scope: DiscountScope
  server_id?: string
  storage_type?: StorageType
  item_id?: string
  mode: DiscountMode
  percent_off?: number
  price_cents?: number
  premium_only: boolean
  // ISO timestamp; omit for a discount that never expires.
  expires_at?: string
  // Email notification group; omit for no emails.
  notify?: NotifyGroup
}

export function createPricingDiscount(input: CreateDiscountInput) {
  return post<{ discount: PricingDiscount; recipients_notified: number }>(
    '/admin/pricing/discounts',
    input,
  )
}

export function deletePricingDiscount(discountId: string) {
  return del<void>(`/admin/pricing/discounts/${discountId}`)
}

// ── User-facing effective plans (storage upgrade modal) ─────────────────────────

// StoragePlanDiscount is the discount the backend already applied to a plan
// row, for the marked-down price display.
export interface StoragePlanDiscount {
  id: string
  scope: DiscountScope
  mode: DiscountMode
  percent: number
  expires_at?: string
  premium_only: boolean
}

// ServerStoragePlan is one purchasable line item priced for the calling user.
// An empty list from the endpoint means the server has no admin-managed
// pricing and the client should fall back to the legacy hardcoded plans.
export interface ServerStoragePlan {
  id: string
  storage_type: StorageType
  bytes: number
  price_cents: number
  effective_cents: number
  discount?: StoragePlanDiscount
}

export async function listServerStoragePlans(serverId: string): Promise<ServerStoragePlan[]> {
  const res = await get<{ items: ServerStoragePlan[] }>(
    `/billing/storage/plans?server_id=${encodeURIComponent(serverId)}`,
  )
  return res.items ?? []
}
