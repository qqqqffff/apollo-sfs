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
