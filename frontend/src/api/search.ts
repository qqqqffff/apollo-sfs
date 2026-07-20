import { get } from './client'
import type { SearchResults } from '../types/api'
import type { FolderPageParams } from './folders'

export interface SearchPageParams extends FolderPageParams {
  // groupLimit=0 skips the recognition-groups list (used for pages after the
  // first — labeled group matches are few, so only the first page fetches them).
  groupLimit?: number
}

export function searchContent(q: string, p: SearchPageParams = {}) {
  const params = new URLSearchParams({ q })
  if (p.folderCursor) params.set('folder_cursor', p.folderCursor)
  if (p.fileCursor) params.set('file_cursor', p.fileCursor)
  if (p.folderLimit !== undefined) params.set('folder_limit', String(p.folderLimit))
  if (p.fileLimit !== undefined) params.set('file_limit', String(p.fileLimit))
  if (p.groupLimit !== undefined) params.set('group_limit', String(p.groupLimit))
  return get<SearchResults>(`/search?${params}`)
}
