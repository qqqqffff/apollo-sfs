import { del, get, post, upload, uploadWithProgress } from './client'
import type { File, FolderContents, Share, UploadResponse } from '../types/api'

// ── Owner operations ──────────────────────────────────────────────────────────

export interface CreateShareInput {
  fileId?: string
  folderId?: string
  recipientEmail: string
  canDownload: boolean
  canUpload?: boolean
  includeChildren?: boolean
  notify: boolean
}

export function createShare(input: CreateShareInput): Promise<Share> {
  return post<Share>('/shares', {
    file_id: input.fileId,
    folder_id: input.folderId,
    recipient_email: input.recipientEmail,
    can_download: input.canDownload,
    can_upload: input.canUpload ?? false,
    include_children: input.includeChildren ?? false,
    notify: input.notify,
  })
}

export function listMyShares(): Promise<{ shares: Share[] }> {
  return get<{ shares: Share[] }>('/shares')
}

export function revokeShare(shareId: string): Promise<{ message: string }> {
  return del<{ message: string }>(`/shares/${shareId}`)
}

// ── Recipient operations ──────────────────────────────────────────────────────

export function listSharedWithMe(): Promise<{ shares: Share[] }> {
  return get<{ shares: Share[] }>('/shares/shared-with-me')
}

/** Resolve a share link token. 403 means logged in as the wrong account. */
export function resolveShareToken(token: string): Promise<Share> {
  return get<Share>(`/shares/resolve/${encodeURIComponent(token)}`)
}

/** Fetch one share (as its recipient or owner). */
export function getShare(shareId: string): Promise<Share> {
  return get<Share>(`/shares/${shareId}`)
}

/** List a shared folder's children. folderId navigates into a descendant. */
export function getSharedContents(shareId: string, folderId?: string | null): Promise<FolderContents> {
  const qs = folderId ? `?folder_id=${folderId}` : ''
  return get<FolderContents>(`/shares/${shareId}/contents${qs}`)
}

/** Metadata for the shared file, or a file inside a shared folder. */
export function getSharedFile(shareId: string, fileId?: string | null): Promise<File> {
  const qs = fileId ? `?file_id=${fileId}` : ''
  return get<File>(`/shares/${shareId}/file${qs}`)
}

export function sharedPreviewUrl(shareId: string, fileId?: string | null): string {
  const qs = fileId ? `?file_id=${fileId}` : ''
  return `/api/v1/shares/${shareId}/file/preview${qs}`
}

export function sharedDownloadUrl(shareId: string, fileId?: string | null): string {
  const qs = fileId ? `?file_id=${fileId}` : ''
  return `/api/v1/shares/${shareId}/file/download${qs}`
}

/** Upload into a shared folder (requires the share's can_upload permission). */
export function uploadToShare(
  shareId: string,
  file: globalThis.File,
  folderId?: string | null,
  onProgress?: (loaded: number, total: number) => void,
): Promise<UploadResponse> {
  const form = new FormData()
  form.append('file', file)
  if (folderId) form.append('folder_id', folderId)
  if (onProgress) return uploadWithProgress<UploadResponse>(`/shares/${shareId}/upload`, form, onProgress)
  return upload<UploadResponse>(`/shares/${shareId}/upload`, form)
}

// ── Query options ─────────────────────────────────────────────────────────────

export const mySharesQueryOptions = {
  queryKey: ['shares', 'mine'] as const,
  queryFn: listMyShares,
}

export const sharedWithMeQueryOptions = {
  queryKey: ['shares', 'with-me'] as const,
  queryFn: listSharedWithMe,
}
