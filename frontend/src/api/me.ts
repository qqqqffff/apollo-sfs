import { get, post } from './client'
import type { User } from '../types/api'

export function getMe() {
  return get<User>('/me')
}

export function changePassword(currentPassword: string, newPassword: string) {
  return post<{ message: string }>('/me/password', {
    current_password: currentPassword,
    new_password: newPassword,
  })
}

export const meQueryOptions = {
  queryKey: ['me'] as const,
  queryFn: getMe,
  retry: false,
  staleTime: 5 * 60 * 1000,
}
