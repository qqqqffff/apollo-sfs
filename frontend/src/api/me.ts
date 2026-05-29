import { get, post, put } from './client'
import type { User, UserPreferences } from '../types/api'

export function getMe() {
  return get<User>('/me')
}

export function changePassword(currentPassword: string, newPassword: string) {
  return post<{ message: string }>('/me/password', {
    current_password: currentPassword,
    new_password: newPassword,
  })
}

export function getPreferences() {
  return get<UserPreferences>('/me/preferences')
}

// updatePreferences sets the media auto-upload target folder. Pass null to disable.
export function updatePreferences(mediaAutouploadFolderId: string | null) {
  return put<UserPreferences>('/me/preferences', {
    media_autoupload_folder_id: mediaAutouploadFolderId,
  })
}

export const preferencesQueryOptions = {
  queryKey: ['preferences'] as const,
  queryFn: getPreferences,
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
