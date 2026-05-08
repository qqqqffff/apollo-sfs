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
  // Re-validate the session every 4 minutes on active tabs so an expiring
  // session is caught before the user triggers an action that would fail.
  refetchInterval: 4 * 60 * 1000,
  refetchIntervalInBackground: false,
}
