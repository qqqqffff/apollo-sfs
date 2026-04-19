import { get } from './client'
import type { User } from '../types/api'

export function getMe() {
  return get<User>('/me')
}

export const meQueryOptions = {
  queryKey: ['me'] as const,
  queryFn: getMe,
  retry: false,
  staleTime: 5 * 60 * 1000,
}
