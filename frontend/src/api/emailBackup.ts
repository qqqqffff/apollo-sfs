// Backend client + orchestration for the email backup feature. The provider
// side (OAuth, fetching messages) lives in emailProviders.ts; this module
// talks to the Apollo SFS API, which encrypts and stores each message as a
// file in the backup folder (quota- and tier-enforced server-side).

import { ApiError, del, get, patch, post } from './client'
import type {
  BackupControl,
  BackupItemStatus,
  BackupProgressEvent,
  BackupRunResult,
} from './backupControl'
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

export type EmailBackupItemStatus = BackupItemStatus

export interface EmailBackupResult extends BackupRunResult {
  // Provider ids of messages that are now safely stored (uploaded or already
  // present), i.e. safe to delete provider-side.
  backedUpIds: string[]
  // Index rows written by this run — the rollback list for a cancel (deleting
  // one also deletes its encrypted file).
  uploadedMessageIds: string[]
}

export interface BackupEmailOptions {
  // Pause/resume/cancel handle; checked between messages.
  control?: BackupControl
  // Fires twice per message — see BackupProgressEvent.
  onProgress?: (e: BackupProgressEvent<ProviderEmailItem>) => void
  // Backup folder name (the account address) so progress can report the
  // message's full destination path.
  folderName?: string
}

// backupEmailEntries downloads each selected message from the provider and
// posts it to the backend one at a time (mirrors uploadGoogleEntries).
// A 409 from the backend means the message was already backed up → duplicate.
export async function backupEmailEntries(
  items: ProviderEmailItem[],
  provider: EmailProvider,
  accessToken: string,
  folderId: string,
  opts: BackupEmailOptions = {},
): Promise<EmailBackupResult> {
  const { control, onProgress, folderName } = opts
  const total = items.length
  let uploaded = 0, duplicates = 0, errors = 0
  const backedUpIds: string[] = []
  const uploadedFileIds: string[] = []
  const uploadedMessageIds: string[] = []
  let cancelled = false

  for (let i = 0; i < total; i++) {
    // Blocks while paused; false once the user cancelled the run.
    if (control && !(await control.gate())) { cancelled = true; break }

    const item = items[i]
    let status: EmailBackupItemStatus = 'error'
    let sizeBytes = 0
    let fileId: string | undefined
    let messageId: string | undefined
    // The server names the stored file (date + subject + id hash); until it
    // answers, show the subject so the line isn't blank while it uploads.
    let path = emailDestPath(folderName, item.subject || '(no subject)')

    onProgress?.({ phase: 'start', entry: item, index: i, done: i, total, path })

    try {
      const message = await downloadProviderMessage(provider, accessToken, item.id)
      const row = await backupEmailMessage(folderId, item, message)
      uploaded++
      backedUpIds.push(item.id)
      status = 'done'
      sizeBytes = row.file_size_bytes ?? 0
      fileId = row.file_id
      messageId = row.id
      if (row.file_id) uploadedFileIds.push(row.file_id)
      if (row.id) uploadedMessageIds.push(row.id)
      if (row.file_name) path = emailDestPath(folderName, row.file_name)
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

    onProgress?.({
      phase: 'settled', entry: item, index: i, done: i + 1, total, path,
      status, sizeBytes, fileId, messageId,
    })
  }

  return { uploaded, duplicates, errors, cancelled, backedUpIds, uploadedFileIds, uploadedMessageIds }
}

function emailDestPath(folderName: string | undefined, name: string): string {
  return folderName ? `${folderName}/${name}` : name
}

// removeBackedUpMessages deletes the index rows (and their encrypted files) a
// run already wrote — the "remove what was backed up" branch of a cancelled
// backup. Best effort per message.
export async function removeBackedUpMessages(ids: string[]): Promise<{ removed: number; failed: number }> {
  let removed = 0, failed = 0
  for (const id of ids) {
    try { await deleteEmailBackupMessage(id); removed++ }
    catch { failed++ }
  }
  return { removed, failed }
}

export { deleteProviderMessages }

// ── Backup settings (localStorage) ────────────────────────────────────────────
// background/notify mirror loadGoogleBackupSettings/saveGoogleBackupSettings
// (api/googleBackup.ts) so both backup flows offer the same settings;
// deleteAfter is email-specific (Google can't delete Drive files it doesn't
// own the trash permission for from a picker selection the same way).

const DELETE_AFTER_KEY = 'apollo_ebackup_delete_after'
const NOTIFY_KEY = 'apollo_ebackup_notify'
const BG_KEY = 'apollo_ebackup_background'

export function loadEmailBackupSettings(): { deleteAfter: boolean; notify: boolean; background: boolean } {
  return {
    deleteAfter: localStorage.getItem(DELETE_AFTER_KEY) === 'true',
    notify: localStorage.getItem(NOTIFY_KEY) !== 'false', // default on
    background: localStorage.getItem(BG_KEY) !== 'false', // default on
  }
}

export function saveEmailBackupSettings(s: { deleteAfter: boolean; notify: boolean; background: boolean }) {
  localStorage.setItem(DELETE_AFTER_KEY, String(s.deleteAfter))
  localStorage.setItem(NOTIFY_KEY, String(s.notify))
  localStorage.setItem(BG_KEY, String(s.background))
}
