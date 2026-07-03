import { get, post, put, del } from './client'
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

export function unlinkProvider(provider: string) {
  return del<{ message: string }>('/me/social/unlink', { provider })
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

// updateStorageUIPreferences toggles the "+" add-storage buttons and the
// automatic upgrade prompt. Only the provided fields are changed.
export function updateStorageUIPreferences(prefs: {
  show_storage_buttons?: boolean
  storage_prompt_enabled?: boolean
}) {
  return put<UserPreferences>('/me/preferences/storage-ui', prefs)
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
}
