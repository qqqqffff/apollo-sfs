import { del, get, patch, post, put } from './client'
import type {
  File,
  PageResult,
  RecognitionGroup,
  RecognitionKind,
  RecognitionStatus,
} from '../types/api'

// getRecognitionStatus returns the collection's toggle state, indexing
// progress counts, group tallies, and crop storage usage.
export function getRecognitionStatus(collectionId: string) {
  return get<RecognitionStatus>(`/collections/${collectionId}/recognition`)
}

// recognitionStatusQueryOptions polls every 5s while indexing is active and
// stops polling once the queue drains.
export function recognitionStatusQueryOptions(collectionId: string, enabled = true) {
  return {
    queryKey: ['recognition', collectionId, 'status'] as const,
    queryFn: () => getRecognitionStatus(collectionId),
    enabled,
    retry: false,
    refetchInterval: (query: { state: { data?: RecognitionStatus } }) => {
      const counts = query.state.data?.counts
      return counts && counts.pending + counts.processing > 0 ? 5_000 : false
    },
  }
}

// setRecognitionEnabled flips the collection's AI toggle. Disabling with
// purge=true also deletes groups/detections/crops and refunds their quota.
export function setRecognitionEnabled(collectionId: string, enabled: boolean, purge = false) {
  return put<{ enabled: boolean; files_enqueued: number; freed_bytes: number }>(
    `/collections/${collectionId}/recognition`,
    { enabled, purge },
  )
}

// listRecognitionGroups returns the collection's groups; kind filters to one
// tab and labeled=true returns only user-labeled groups (the Labeled sub-tab).
export function listRecognitionGroups(collectionId: string, kind?: RecognitionKind, labeled?: boolean) {
  const params = new URLSearchParams()
  if (kind) params.set('kind', kind)
  if (labeled) params.set('labeled', 'true')
  const qs = params.toString()
  return get<{ groups: RecognitionGroup[] }>(
    `/collections/${collectionId}/recognition/groups${qs ? `?${qs}` : ''}`,
  )
}

export function recognitionGroupsQueryOptions(collectionId: string, kind?: RecognitionKind, labeled?: boolean) {
  return {
    queryKey: ['recognition', collectionId, 'groups', kind ?? 'all', labeled ?? false] as const,
    queryFn: () => listRecognitionGroups(collectionId, kind, labeled),
  }
}

// getGroupFiles pages a group's files (same shape as the media grid).
export function getGroupFiles(groupId: string, cursor?: string) {
  const params = new URLSearchParams()
  if (cursor) params.set('file_cursor', cursor)
  const qs = params.toString()
  return get<PageResult<File>>(`/recognition/groups/${groupId}/files${qs ? `?${qs}` : ''}`)
}

// renameGroup sets the user label; empty string clears it back to auto.
export function renameGroup(groupId: string, label: string) {
  return patch<RecognitionGroup>(`/recognition/groups/${groupId}`, { label })
}

// mergeGroups folds the source groups into the target (same kind/species only).
export function mergeGroups(targetGroupId: string, sourceGroupIds: string[]) {
  return post<RecognitionGroup>(`/recognition/groups/${targetGroupId}/merge`, {
    source_group_ids: sourceGroupIds,
  })
}

export function deleteGroup(groupId: string) {
  return del<{ ok: boolean }>(`/recognition/groups/${groupId}`)
}

// detectionThumbUrl is a stable cookie-authenticated URL for a face/pet crop
// (mirrors previewUrl in api/files.ts).
export function detectionThumbUrl(detectionId: string) {
  return `/api/v1/recognition/detections/${detectionId}/thumb`
}
