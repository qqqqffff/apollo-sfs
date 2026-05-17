import { post, get } from './client'

export interface PublicConfig {
  turnstile_site_key: string
}

export function getPublicConfig() {
  return get<PublicConfig>('/config')
}

export interface SubmitInterestPayload {
  name: string
  email: string
  desired_storage_gb: number
  use_case: string
  captcha_token: string
}

export function submitInterestForm(payload: SubmitInterestPayload) {
  return post<{ message: string }>('/interest', payload)
}

export const publicConfigQueryOptions = {
  queryKey: ['public', 'config'] as const,
  queryFn: getPublicConfig,
  staleTime: Infinity,
}
