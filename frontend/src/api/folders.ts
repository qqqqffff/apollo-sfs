import { del, get, patch, post } from './client'
import type { Folder, FolderContents } from '../types/api'

export interface FolderPageParams {
  folderCursor?: string
  fileCursor?: string
  folderLimit?: number
  fileLimit?: number
}

function buildQS(p: FolderPageParams): string {
  const params = new URLSearchParams()
  if (p.folderCursor) params.set('folder_cursor', p.folderCursor)
  if (p.fileCursor) params.set('file_cursor', p.fileCursor)
  if (p.folderLimit !== undefined) params.set('folder_limit', String(p.folderLimit))
  if (p.fileLimit !== undefined) params.set('file_limit', String(p.fileLimit))
  return params.size ? `?${params}` : ''
}

export function listRoot(p: FolderPageParams = {}) {
  return get<FolderContents>(`/folders${buildQS(p)}`)
}

export function getFolder(folderId: string, p: FolderPageParams = {}) {
  return get<FolderContents>(`/folders/${folderId}${buildQS(p)}`)
}

export function createFolder(name: string, parent_id?: string) {
  return post<Folder>('/folders', { name, parent_id: parent_id ?? null })
}

export function renameFolder(folderId: string, name: string) {
  return patch<Folder>(`/folders/${folderId}`, { name })
}

export function moveFolder(folderId: string, targetFolderId: string) {
  return patch<Folder>(`/folders/${folderId}/move`, { target_folder_id: targetFolderId })
}

export function deleteFolder(folderId: string) {
  return del<{ message: string }>(`/folders/${folderId}`)
}

export const rootQueryOptions = {
  queryKey: ['folders', 'root'] as const,
  queryFn: () => listRoot(),
}

export const folderQueryOptions = (folderId: string) => ({
  queryKey: ['folders', folderId] as const,
  queryFn: () => getFolder(folderId),
})
