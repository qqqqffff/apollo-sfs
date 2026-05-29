import { del, get, patch, post, upload, uploadWithProgress } from './client'
import type { File, UploadResponse } from '../types/api'

export const CHUNK_SIZE = 5 * 1024 * 1024 // 5 MB

// ── Chunked upload (cookie auth) ──────────────────────────────────────────────

export function initChunkedUpload(
  name: string,
  totalChunks: number,
  totalSize: number,
  folderId: string | null,
): Promise<{ upload_id: string }> {
  return post('/files/upload/init', {
    name,
    total_chunks: totalChunks,
    total_size: totalSize,
    folder_id: folderId ?? undefined,
  })
}

export function uploadChunk(
  uploadId: string,
  chunkIndex: number,
  chunk: Blob,
  onProgress: (loaded: number, total: number) => void,
): Promise<{ chunk_index: number; dispatched: number; total: number }> {
  const form = new FormData()
  form.append('chunk', chunk)
  form.append('chunk_index', String(chunkIndex))
  return uploadWithProgress(`/files/upload/${uploadId}/chunk`, form, onProgress)
}

export function completeChunkedUpload(uploadId: string): Promise<UploadResponse> {
  return post<UploadResponse>(`/files/upload/${uploadId}/complete`)
}

// ── Single-file upload (cookie auth) ─────────────────────────────────────────

export function getFile(fileId: string) {
  return get<File>(`/files/${fileId}`)
}

export function uploadFile(
  folderId: string | null,
  file: globalThis.File,
  onProgress?: (loaded: number, total: number) => void,
  name?: string,
) {
  const form = new FormData()
  form.append('file', file)
  if (folderId) form.append('folder_id', folderId)
  if (name) form.append('name', name)
  if (onProgress) return uploadWithProgress<UploadResponse>('/files/upload', form, onProgress)
  return upload<UploadResponse>('/files/upload', form)
}

// ── Metadata / management ─────────────────────────────────────────────────────

export function renameFile(fileId: string, name: string) {
  return patch<File>(`/files/${fileId}`, { name })
}

export function deleteFile(fileId: string) {
  return del<{ message: string }>(`/files/${fileId}`)
}

export function moveFile(fileId: string, targetFolderId: string) {
  return patch<File>(`/files/${fileId}/move`, { folder_id: targetFolderId })
}

export function hideFile(fileId: string) {
  return patch<File>(`/files/${fileId}/hide`, {})
}

export function unhideFile(fileId: string) {
  return patch<File>(`/files/${fileId}/unhide`, {})
}

// ── Presigned URL helpers ─────────────────────────────────────────────────────

export interface PresignFileResponse {
  download_url: string
  preview_url: string
  expires_at: string
}

/** Request time-limited download and preview URLs for a file the caller owns. */
export function presignFile(fileId: string): Promise<PresignFileResponse> {
  return post<PresignFileResponse>(`/files/${fileId}/presign`)
}

export interface PresignUploadResponse {
  url: string
  expires_at: string
}

/** Request a presigned single-file upload URL. */
export function presignUpload(
  name: string,
  size: number,
  folderId: string | null,
): Promise<PresignUploadResponse> {
  return post<PresignUploadResponse>('/files/upload/presign', {
    name,
    size,
    folder_id: folderId ?? undefined,
  })
}

export interface PresignChunkedUploadResponse {
  upload_id: string
  session_token: string
  expires_at: string
}

/** Request a presigned session token for a chunked upload. */
export function presignChunkedUpload(
  name: string,
  totalChunks: number,
  totalSize: number,
  folderId: string | null,
): Promise<PresignChunkedUploadResponse> {
  return post<PresignChunkedUploadResponse>('/files/upload/presign/init', {
    name,
    total_chunks: totalChunks,
    total_size: totalSize,
    folder_id: folderId ?? undefined,
  })
}

/** Upload a single chunk using a presigned session token (no cookie required). */
export function uploadChunkPresigned(
  uploadId: string,
  sessionToken: string,
  chunkIndex: number,
  chunk: Blob,
  onProgress: (loaded: number, total: number) => void,
): Promise<{ chunk_index: number; dispatched: number; total: number }> {
  const form = new FormData()
  form.append('chunk', chunk)
  form.append('chunk_index', String(chunkIndex))
  return uploadWithProgress(
    `/files/upload/${uploadId}/chunk/p?token=${encodeURIComponent(sessionToken)}`,
    form,
    onProgress,
  )
}

/** Finalise a presigned chunked upload (no cookie required). */
export function completeChunkedUploadPresigned(
  uploadId: string,
  sessionToken: string,
): Promise<UploadResponse> {
  return post<UploadResponse>(
    `/files/upload/${uploadId}/complete/p?token=${encodeURIComponent(sessionToken)}`,
  )
}

/** Upload a single file using a presigned URL (no cookie required). */
export function uploadFilePresigned(
  presignedUrl: string,
  file: globalThis.File,
  onProgress?: (loaded: number, total: number) => void,
  name?: string,
) {
  // presignedUrl is an absolute path like /api/v1/files/upload/p?token=...
  // Strip the /api/v1 prefix so uploadWithProgress can prepend BASE correctly.
  const path = presignedUrl.replace(/^\/api\/v1/, '')
  const form = new FormData()
  form.append('file', file)
  if (name) form.append('name', name)
  if (onProgress) return uploadWithProgress<UploadResponse>(path, form, onProgress)
  return upload<UploadResponse>(path, form)
}

// ── Stable URL helpers (cookie-auth, still used for streaming) ────────────────

export function downloadUrl(fileId: string) {
  return `/api/v1/files/${fileId}/download`
}

export function previewUrl(fileId: string) {
  return `/api/v1/files/${fileId}/preview`
}

export function streamUrl(fileId: string, quality?: 'low') {
  const qs = quality ? `?quality=${quality}` : ''
  return `/api/v1/files/${fileId}/stream${qs}`
}

export const fileQueryOptions = (fileId: string) => ({
  queryKey: ['files', fileId] as const,
  queryFn: () => getFile(fileId),
})
