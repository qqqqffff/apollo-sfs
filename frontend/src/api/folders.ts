import { del, get, patch, post } from './client'
import type { DriveMigrationEligibility, Folder, FolderContents, FolderDriveMigration, FolderKind, HiddenMode, MediaFilters, MediaSort } from '../types/api'

export interface FolderPageParams {
  folderCursor?: string
  fileCursor?: string
  folderLimit?: number
  fileLimit?: number
  // Tier-first browser: scope the virtual root to a single drive (server &
  // tier). Only honored by listRoot. includeUnassigned should be set only when
  // that drive is the user's primary — NULL-drive rows resolve to the primary.
  drive?: string
  includeUnassigned?: boolean
}

function buildQS(p: FolderPageParams): string {
  const params = new URLSearchParams()
  if (p.folderCursor) params.set('folder_cursor', p.folderCursor)
  if (p.fileCursor) params.set('file_cursor', p.fileCursor)
  if (p.folderLimit !== undefined) params.set('folder_limit', String(p.folderLimit))
  if (p.fileLimit !== undefined) params.set('file_limit', String(p.fileLimit))
  if (p.drive) params.set('drive', p.drive)
  if (p.includeUnassigned) params.set('include_unassigned', 'true')
  return params.size ? `?${params}` : ''
}

export function listRoot(p: FolderPageParams = {}) {
  return get<FolderContents>(`/folders${buildQS(p)}`)
}

export function getFolder(folderId: string, p: FolderPageParams = {}) {
  return get<FolderContents>(`/folders/${folderId}${buildQS(p)}`)
}

export interface MediaPageParams extends FolderPageParams {
  sort?: MediaSort
  hidden?: HiddenMode
  filters?: MediaFilters
}

// dayBoundary converts a `YYYY-MM-DD` value from an <input type="date"> into
// an RFC3339 instant at the start (or end) of that day **in the viewer's own
// time zone** — a bare date would be read as UTC midnight server-side, which
// silently clips items shot late in the day for anyone west of UTC.
function dayBoundary(date: string, edge: 'start' | 'end'): string | null {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return null
  const dt = edge === 'start'
    ? new Date(y, m - 1, d, 0, 0, 0, 0)
    : new Date(y, m - 1, d, 23, 59, 59, 999)
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString()
}

// appendMediaFilters writes the filter facets onto a query string. Shared by
// the listing and the id-only endpoint so both always agree on what a given
// filter means.
function appendMediaFilters(params: URLSearchParams, f: MediaFilters | undefined) {
  if (!f) return
  const ranges: [string, string, 'start' | 'end'][] = [
    ['taken_after', f.takenAfter, 'start'],
    ['taken_before', f.takenBefore, 'end'],
    ['uploaded_after', f.uploadedAfter, 'start'],
    ['uploaded_before', f.uploadedBefore, 'end'],
  ]
  for (const [key, value, edge] of ranges) {
    if (!value) continue
    const iso = dayBoundary(value, edge)
    if (iso) params.set(key, iso)
  }
  if (f.sources.length > 0) params.set('source', f.sources.join(','))
  if (f.mediaTypes.length > 0) params.set('media_type', f.mediaTypes.join(','))
  if (f.groupIds.length > 0) params.set('group', f.groupIds.join(','))
}

function mediaQS(p: MediaPageParams): URLSearchParams {
  const params = new URLSearchParams(buildQS(p).replace(/^\?/, ''))
  if (p.sort) params.set('sort', p.sort)
  if (p.hidden && p.hidden !== 'hide') params.set('hidden', p.hidden === 'only' ? 'only' : 'show')
  appendMediaFilters(params, p.filters)
  return params
}

// getMediaFolder fetches a media collection's subcollections and media files
// (physical residents plus pointers), ordered by sort and narrowed by hidden
// state plus the optional filter facets.
export function getMediaFolder(folderId: string, p: MediaPageParams = {}) {
  const params = mediaQS(p)
  const qs = params.size ? `?${params}` : ''
  return get<FolderContents>(`/folders/${folderId}/media${qs}`)
}

// getMediaFileIds returns the ids of every file matching the same sort/hidden/
// filter params getMediaFolder accepts — what "select everything matching this
// filter" needs, since the grid only ever holds the pages loaded so far.
// truncated is set when the server's cap was hit.
export function getMediaFileIds(folderId: string, p: MediaPageParams = {}) {
  const params = mediaQS(p)
  const qs = params.size ? `?${params}` : ''
  return get<{ file_ids: string[]; truncated: boolean }>(`/folders/${folderId}/media/ids${qs}`)
}

export function createFolder(name: string, parent_id?: string, kind: FolderKind = 'regular', drive_id?: string) {
  return post<Folder>('/folders', { name, parent_id: parent_id ?? null, kind, drive_id: drive_id ?? null })
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

// getAncestors returns the breadcrumb chain from root → leaf for folderId.
// Backed by a single recursive-CTE query on the server.
export function getAncestors(folderId: string) {
  return get<{ ancestors: Folder[] }>(`/folders/${folderId}/ancestors`)
}

export const ancestorsQueryOptions = (folderId: string) => ({
  queryKey: ['folders', folderId, 'ancestors'] as const,
  queryFn: () => getAncestors(folderId),
})

// resolvePathToFolder walks a `/`-joined path of folder names down from the
// virtual root, matching each segment against that level's subfolders by
// name. Returns the matching Folder only if the *entire* path resolves to an
// existing folder — a partial match returns null, since an unresolved
// segment means that folder doesn't exist yet and will be auto-created
// (unpinned, i.e. today's dynamic-routing default) the first time something
// is written there. Used to seed the API key prefix picker from an existing
// scope, and to derive the storage-location badge for existing keys (their
// scopes only store the name-based path, not a folder id).
export async function resolvePathToFolder(path: string): Promise<Folder | null> {
  const segments = path.split('/').map((s) => s.trim()).filter(Boolean)
  if (segments.length === 0) return null
  let contents = await listRoot({ folderLimit: 200 })
  let match: Folder | null = null
  for (const seg of segments) {
    const found = contents.subfolders.items.find((f) => f.name === seg)
    if (!found) return null
    match = found
    contents = await getFolder(found.id, { folderLimit: 200 })
  }
  return match
}

// requestDriveMigration kicks off a background job moving a folder's whole
// subtree to a different drive (server & tier) and reparenting it under
// destParentId there (omit/undefined = the destination drive's root). Returns
// the created migration row (202 Accepted — the move runs asynchronously).
export function requestDriveMigration(folderId: string, driveId: string, destParentId?: string | null) {
  return post<FolderDriveMigration>(`/folders/${folderId}/drive-migrations`, {
    drive_id: driveId,
    dest_parent_id: destParentId ?? null,
  })
}

// getLatestDriveMigration returns the most recent migration for a folder
// plus rate-limit eligibility info (3 changes per folder per rolling 30 days).
export function getLatestDriveMigration(folderId: string) {
  return get<DriveMigrationEligibility>(`/folders/${folderId}/drive-migrations/latest`)
}
