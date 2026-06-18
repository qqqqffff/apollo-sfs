import { post, get } from './client'

export interface PublicConfig {
  turnstile_site_key: string
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

export function createInterestDepositOrder(planId: string, storageType: StorageType) {
  return post<CreateInterestDepositResponse>('/interest/deposit/orders', { plan_id: planId, storage_type: storageType })
}

export function captureInterestDepositOrder(orderId: string) {
  return post<{ capture_id: string; status: string }>(`/interest/deposit/orders/${orderId}/capture`)
}

export const publicConfigQueryOptions = {
  queryKey: ['public', 'config'] as const,
  queryFn: getPublicConfig,
  staleTime: Infinity,
}
