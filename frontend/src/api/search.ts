import { get } from './client'
import type { FolderContents } from '../types/api'
import type { FolderPageParams } from './folders'

export function searchContent(q: string, p: FolderPageParams = {}) {
  const params = new URLSearchParams({ q })
  if (p.folderCursor) params.set('folder_cursor', p.folderCursor)
  if (p.fileCursor) params.set('file_cursor', p.fileCursor)
  if (p.folderLimit !== undefined) params.set('folder_limit', String(p.folderLimit))
  if (p.fileLimit !== undefined) params.set('file_limit', String(p.fileLimit))
  return get<FolderContents>(`/search?${params}`)
}
