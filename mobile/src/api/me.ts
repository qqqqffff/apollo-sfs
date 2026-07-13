import api from './client';

// Mirrors frontend/src/types/api.ts User.
export interface User {
  username: string;
  email: string;
  storage_used_bytes: number;
  storage_quota_bytes: number;
  last_seen_at: string | null;
  created_at: string;
  is_admin: boolean;
  is_premium: boolean;
  premium_granted_at: string | null;
  // True when the user has an active/suspended premium subscription of their
  // own — distinct from is_premium, which is also true for every admin.
  premium_subscribed: boolean;
  premium_environment?: 'sandbox' | 'live';
  premium_plan?: 'monthly' | 'annual';
  premium_current_period_end?: string | null;
  linked_providers: string[];
  // Admin's session-scoped toggles (reset on logout/session expiry).
  sandbox_payments_enabled: boolean;
  expansion_override_enabled: boolean;
}

export async function getMe(): Promise<User> {
  const res = await api.get<User>('/api/v1/me');
  return res.data;
}

// updateUsername renames the signed-in user's account. The current session's
// token still carries the old username afterwards, so callers should sign the
// user out on success to force a fresh login with the new identity.
export async function updateUsername(newUsername: string): Promise<void> {
  await api.patch('/api/v1/me/username', { new_username: newUsername });
}

// requestPasswordChangeCode emails a one-time two-factor code to the signed-in
// user's account address, required to complete changePassword.
export async function requestPasswordChangeCode(): Promise<void> {
  await api.post('/api/v1/me/password/request-code');
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
  code: string,
): Promise<void> {
  await api.post('/api/v1/me/password', {
    current_password: currentPassword,
    new_password: newPassword,
    code,
  });
}

// updateStorageUIPreferences toggles the "+" add-storage buttons and the
// automatic upgrade prompt. Only the provided fields are changed.
export async function updateStorageUIPreferences(prefs: {
  show_storage_buttons?: boolean;
  storage_prompt_enabled?: boolean;
}): Promise<void> {
  await api.put('/api/v1/me/preferences/storage-ui', prefs);
}

// updateSandboxPayments toggles the admin-only, session-scoped sandbox
// payments mode (resets on logout/session expiry).
export async function updateSandboxPayments(enabled: boolean): Promise<void> {
  await api.put('/api/v1/me/sandbox-payments', { enabled });
}

// updateExpansionOverride toggles the admin-only, session-scoped override that
// forces the Add Storage modal to always show a capacity expansion request
// instead of a direct purchase (resets on logout/session expiry).
export async function updateExpansionOverride(enabled: boolean): Promise<void> {
  await api.put('/api/v1/me/expansion-override', { enabled });
}

// ── Notifications ──────────────────────────────────────────────────────────

export type NotificationKind =
  | 'capacity_provisioned' | 'payment_required' | 'action_pending' | 'share_received'
  | 'subscription_cancelled' | 'quota_changed'
  // Admin-only categories (empty for non-admin users).
  | 'invitation_accepted' | 'order_received' | 'email_received' | 'alarm_triggered';

export interface QuotaAllocationSnapshot {
  drive_id: string;
  server_name: string;
  drive_type: 'nvme' | 'hdd';
  quota_bytes: number;
}

export interface StorageAllocationChangeDetails {
  reason?: string;
  before: QuotaAllocationSnapshot[];
  after: QuotaAllocationSnapshot[];
}

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string;
  created_at: string;
  // Structured before/after breakdown — only set for quota_changed.
  details?: StorageAllocationChangeDetails;
}

export async function listNotifications(): Promise<AppNotification[]> {
  const res = await api.get<{ items: AppNotification[] }>('/api/v1/me/notifications');
  return res.data.items ?? [];
}

export async function dismissNotifications(ids: string[]): Promise<void> {
  await api.post('/api/v1/me/notifications/dismiss', { ids });
}

// dismissNotificationCategory dismisses every notification currently in the
// given category — resolved and persisted server-side.
export async function dismissNotificationCategory(category: string): Promise<void> {
  await api.post(`/api/v1/me/notifications/dismiss?category=${encodeURIComponent(category)}`);
}

export async function unlinkProvider(provider: string): Promise<void> {
  await api.delete('/api/v1/me/social/unlink', { data: { provider } });
}
