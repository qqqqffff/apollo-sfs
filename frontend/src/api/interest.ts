import { post, get } from './client'

export interface PublicPremiumPlanOption {
  plan: 'monthly' | 'annual'
  price_cents: number
}

export interface PublicConfig {
  turnstile_site_key: string
  // Public PayPal config for the hosted card fields SDK on the (unauthenticated)
  // interest and register pages. Always the live client id.
  paypal_client_id?: string
  paypal_currency?: string
  paypal_environment?: string
  // Recurring premium plan prices — shown on the register page's inline
  // premium subscribe flow.
  premium_plans?: PublicPremiumPlanOption[]
}

export function getPublicConfig() {
  return get<PublicConfig>('/config')
}

// Unauthenticated counterpart of getPayPalClientToken (api/billing.ts) for the
// public interest page's Apple Pay button — always the live client, like
// getPublicConfig above.
export function getPublicPayPalClientToken() {
  return get<{ client_token: string; expires_in: number; environment: 'sandbox' | 'live' }>(
    '/config/paypal-client-token',
  )
}

export type StorageType = 'nvme' | 'hdd'

export interface SubmitInterestPayload {
  name: string
  email: string
  desired_storage_gb: number
  storage_type: StorageType
  plan_id: string
  use_case: string
  captcha_token: string
  deposit_order_id: string
}

export function submitInterestForm(payload: SubmitInterestPayload) {
  return post<{ message: string }>('/interest', payload)
}

export interface CreateInterestDepositResponse {
  order_id: string
  approve_url: string
}

export function createInterestDepositOrder(planId: string, storageType: StorageType, paymentMethod: 'paypal' | 'card' = 'paypal') {
  return post<CreateInterestDepositResponse>('/interest/deposit/orders', { plan_id: planId, storage_type: storageType, payment_method: paymentMethod })
}

export function captureInterestDepositOrder(orderId: string) {
  return post<{ capture_id: string; status: string }>(`/interest/deposit/orders/${orderId}/capture`)
}

export function createGooglePayInterestDeposit(planId: string, storageType: StorageType, paymentToken: string) {
  return post<{ order_id: string }>('/interest/deposit/orders/google-pay', { plan_id: planId, storage_type: storageType, payment_token: paymentToken })
}

export const publicConfigQueryOptions = {
  queryKey: ['public', 'config'] as const,
  queryFn: getPublicConfig,
  staleTime: Infinity,
}

// ── Drive tier benchmark (public summary) ────────────────────────────────────
// Fast-vs-standard write/read comparison shown on the home page, registration,
// and Add Storage modal promo cards — see docs/drive_benchmark_setup.md. The
// admin metrics page uses the richer per-disk admin.ts version instead.

export interface PublicTierBenchmarkStat {
  seq_write_mbps: number
  seq_read_mbps: number
  random_write_mbps: number
  random_write_iops: number
  random_read_mbps: number
  random_read_iops: number
  disk_count: number
  tested_at: string
}

export interface PublicDriveBenchmarkSummary {
  /** False until the first admin-triggered benchmark run has ever completed. */
  available: boolean
  fast?: PublicTierBenchmarkStat
  standard?: PublicTierBenchmarkStat
}

export function getPublicDriveBenchmark() {
  return get<PublicDriveBenchmarkSummary>('/drive-benchmark')
}

export const publicDriveBenchmarkQueryOptions = {
  queryKey: ['public', 'drive-benchmark'] as const,
  queryFn: getPublicDriveBenchmark,
  staleTime: 5 * 60 * 1000,
}
