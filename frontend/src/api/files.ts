import { del, get, patch, upload } from './client'
import type { File, UploadResponse } from '../types/api'

export function getFile(fileId: string) {
  return get<File>(`/files/${fileId}`)
}

export function uploadFile(folderId: string | null, file: globalThis.File, name?: string) {
  const form = new FormData()
  form.append('file', file)
  if (folderId) form.append('folder_id', folderId)
  if (name) form.append('name', name)
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

export function streamUrl(fileId: string) {
  return `/api/v1/files/${fileId}/stream`
}

export const fileQueryOptions = (fileId: string) => ({
  queryKey: ['files', fileId] as const,
  queryFn: () => getFile(fileId),
})
