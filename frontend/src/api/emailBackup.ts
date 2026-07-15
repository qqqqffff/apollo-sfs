// Backend client + orchestration for the email backup feature. The provider
// side (OAuth, fetching messages) lives in emailProviders.ts; this module
// talks to the Apollo SFS API, which encrypts and stores each message as a
// file in the backup folder (quota- and tier-enforced server-side).

import { ApiError, del, get, patch, post } from './client'
import type { Folder, PageResult } from '../types/api'
import type { EmailBackupDetail, EmailBackupMessage, EmailBackupRun, EmailBackupSender } from '../types/emailBackup'
import {
  deleteProviderMessages,
  downloadProviderMessage,
  type EmailProvider,
  type ProviderEmailItem,
  type StoredEmailPayload,
} from './emailProviders'

// ── Backend endpoints ─────────────────────────────────────────────────────────

export function ensureEmailBackupFolder(emailAddress: string, driveId?: string | null) {
  return post<{ folder: Folder; created: boolean }>('/email-backup/folders', {
    email_address: emailAddress,
    drive_id: driveId ?? null,
  })
}

export function backupEmailMessage(
  folderId: string,
  item: ProviderEmailItem,
  message: StoredEmailPayload,
) {
  return post<EmailBackupMessage>('/email-backup/messages', {
    folder_id: folderId,
    provider: item.provider,
    provider_message_id: item.id,
    snippet: item.snippet,
    starred: item.starred,
    message,
  })
}

export function listEmailBackupSenders(folderId: string) {
  return get<{ senders: EmailBackupSender[] }>(`/email-backup/folders/${folderId}/senders`)
}

export function listEmailBackupMessages(folderId: string, sender?: string, cursor?: string, limit?: number) {
  const params = new URLSearchParams()
  if (sender) params.set('sender', sender)
  if (cursor) params.set('cursor', cursor)
  if (limit) params.set('limit', String(limit))
  const qs = params.size ? `?${params}` : ''
  return get<PageResult<EmailBackupMessage>>(`/email-backup/folders/${folderId}/messages${qs}`)
}

export function getEmailBackupMessage(id: string) {
  return get<EmailBackupDetail>(`/email-backup/messages/${id}`)
}

export function markEmailBackupMessageRead(id: string) {
  return patch<{ message: string }>(`/email-backup/messages/${id}/read`, {})
}

export function deleteEmailBackupMessage(id: string) {
  return del<{ message: string }>(`/email-backup/messages/${id}`)
}

export function completeEmailBackupRun(run: {
  folder_id: string | null
  email_address: string
  provider: EmailProvider
  uploaded: number
  duplicates: number
  errors: number
  notify: boolean
}) {
  return post<EmailBackupRun>('/email-backup/runs', run)
}

// ── Query options ─────────────────────────────────────────────────────────────

export function emailBackupSendersQueryOptions(folderId: string) {
  return {
    queryKey: ['email-backup', folderId, 'senders'] as const,
    queryFn: () => listEmailBackupSenders(folderId),
  }
}

export function emailBackupMessagesInfiniteQueryOptions(folderId: string, sender?: string) {
  return {
    queryKey: ['email-backup', folderId, 'messages', sender ?? 'all'] as const,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      listEmailBackupMessages(folderId, sender, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: PageResult<EmailBackupMessage>) =>
      lastPage.next_token || undefined,
  }
}

// ── Backup orchestration ──────────────────────────────────────────────────────

export type EmailBackupItemStatus = 'done' | 'duplicate' | 'error'

export interface EmailBackupResult {
  uploaded: number
  duplicates: number
  errors: number
  // Provider ids of messages that are now safely stored (uploaded or already
  // present), i.e. safe to delete provider-side.
  backedUpIds: string[]
}

// backupEmailEntries downloads each selected message from the provider and
// posts it to the backend one at a time (mirrors uploadGoogleEntries).
// A 409 from the backend means the message was already backed up → duplicate.
export async function backupEmailEntries(
  items: ProviderEmailItem[],
  provider: EmailProvider,
  accessToken: string,
  folderId: string,
  onProgress?: (
    done: number,
    total: number,
    finished?: { item: ProviderEmailItem; status: EmailBackupItemStatus },
  ) => void,
): Promise<EmailBackupResult> {
  const total = items.length
  let uploaded = 0, duplicates = 0, errors = 0
  const backedUpIds: string[] = []

  for (let i = 0; i < total; i++) {
    const item = items[i]
    let status: EmailBackupItemStatus = 'error'
    try {
      const message = await downloadProviderMessage(provider, accessToken, item.id)
      await backupEmailMessage(folderId, item, message)
      uploaded++
      backedUpIds.push(item.id)
      status = 'done'
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        duplicates++
        backedUpIds.push(item.id)
        status = 'duplicate'
      } else {
        errors++
        status = 'error'
      }
    }
    onProgress?.(i + 1, total, { item, status })
  }

  return { uploaded, duplicates, errors, backedUpIds }
}

export { deleteProviderMessages }

// ── Backup settings (localStorage) ────────────────────────────────────────────

const DELETE_AFTER_KEY = 'apollo_ebackup_delete_after'
const NOTIFY_KEY = 'apollo_ebackup_notify'

export function loadEmailBackupSettings(): { deleteAfter: boolean; notify: boolean } {
  return {
    deleteAfter: localStorage.getItem(DELETE_AFTER_KEY) === 'true',
    notify: localStorage.getItem(NOTIFY_KEY) !== 'false', // default on
  }
}

export function saveEmailBackupSettings(s: { deleteAfter: boolean; notify: boolean }) {
  localStorage.setItem(DELETE_AFTER_KEY, String(s.deleteAfter))
  localStorage.setItem(NOTIFY_KEY, String(s.notify))
}
