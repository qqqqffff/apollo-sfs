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

// linkProvider completes the web "Connect" flow: `code` is the Keycloak
// authorization code the brokered IdP login redirected back to the profile page
// with (see socialLinkUrl). The backend exchanges it and attaches the resulting
// identity to the signed-in account.
export function linkProvider(provider: string, code: string) {
  return post<{ message: string }>('/me/social/link', { provider, code })
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

// updateStorageUIPreferences toggles the "+" add-storage buttons, the
// automatic upgrade prompt, and the drive-benchmark promo card shown in the
// Add Storage modal. Only the provided fields are changed.
export function updateStorageUIPreferences(prefs: {
  show_storage_buttons?: boolean
  storage_prompt_enabled?: boolean
  hide_benchmark_promo?: boolean
}) {
  return put<UserPreferences>('/me/preferences/storage-ui', prefs)
}

// updateBackupReminderPreference toggles the premium-only bell warning shown
// when the most recent Google or email backup is more than 30 days old.
export function updateBackupReminderPreference(enabled: boolean) {
  return put<UserPreferences>('/me/preferences/backup-reminder', {
    backup_stale_notify: enabled,
  })
}

// updateDefaultDrive sets the drive (server & tier) the file browser lands on
// for a multi-drive user. Pass null to clear it. The drive must be one of the
// user's own allocations.
export function updateDefaultDrive(driveId: string | null) {
  return put<UserPreferences>('/me/preferences/default-drive', {
    default_drive_id: driveId,
  })
}

// markOnboardingGuideSeen records that one of the onboarding spotlight tours
// has been shown, so it never auto-plays again for this account. Idempotent —
// the flag only ever goes false → true.
export function markOnboardingGuideSeen(guide: 'base' | 'premium') {
  return put<UserPreferences>('/me/preferences/onboarding', { guide })
}

// LastBackupSync reports when each backup type last completed; null means the
// user has never used that backup.
export interface LastBackupSync {
  google_last_sync: string | null
  email_last_sync: string | null
}

export function getLastBackupSync() {
  return get<LastBackupSync>('/me/backups/last-sync')
}

export const lastBackupSyncQueryOptions = {
  queryKey: ['me', 'backups', 'last-sync'] as const,
  queryFn: getLastBackupSync,
}

// updateSandboxPayments toggles the admin-only, session-scoped sandbox
// payments mode (resets on logout/session expiry — not a persisted
// preference, hence not part of UserPreferences).
export function updateSandboxPayments(enabled: boolean) {
  return put<{ sandbox_payments_enabled: boolean }>('/me/sandbox-payments', { enabled })
}

// updateExpansionOverride toggles the admin-only, session-scoped override
// that forces the Add Storage modal to always show a capacity expansion
// request instead of a direct purchase (resets on logout/session expiry —
// not a persisted preference, hence not part of UserPreferences).
export function updateExpansionOverride(enabled: boolean) {
  return put<{ expansion_override_enabled: boolean }>('/me/expansion-override', { enabled })
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
