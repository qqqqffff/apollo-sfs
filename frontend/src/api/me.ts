import { get, post, put, patch, del } from './client'
import type { User, UserPreferences } from '../types/api'

export function getMe() {
  return get<User>('/me')
}

// requestPasswordChangeCode emails a one-time two-factor code to the signed-in
// user's account address, required to complete changePassword.
export function requestPasswordChangeCode() {
  return post<{ message: string }>('/me/password/request-code')
}

export function changePassword(currentPassword: string, newPassword: string, code: string) {
  return post<{ message: string }>('/me/password', {
    current_password: currentPassword,
    new_password: newPassword,
    code,
  })
}

export function unlinkProvider(provider: string) {
  return del<{ message: string }>('/me/social/unlink', { provider })
}

// updateUsername renames the signed-in user's account. The current session's
// token still carries the old username afterwards, so callers should sign the
// user out on success to force a fresh login with the new identity.
export function updateUsername(newUsername: string) {
  return patch<{ message: string }>('/me/username', { new_username: newUsername })
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

// updateSandboxPayments toggles the admin-only, session-scoped sandbox
// payments mode (resets on logout/session expiry — not a persisted
// preference, hence not part of UserPreferences).
export function updateSandboxPayments(enabled: boolean) {
  return put<{ sandbox_payments_enabled: boolean }>('/me/sandbox-payments', { enabled })
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
