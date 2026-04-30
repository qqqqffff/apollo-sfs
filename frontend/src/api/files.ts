import { del, get, patch, post, upload, uploadWithProgress } from './client'
import type { File, UploadResponse } from '../types/api'

export const CHUNK_SIZE = 5 * 1024 * 1024 // 5 MB

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

export function renameFile(fileId: string, name: string) {
  return patch<File>(`/files/${fileId}`, { name })
}

export function deleteFile(fileId: string) {
  return del<{ message: string }>(`/files/${fileId}`)
}

export function moveFile(fileId: string, targetFolderId: string) {
  return patch<File>(`/files/${fileId}/move`, { folder_id: targetFolderId })
}

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
