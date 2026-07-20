import api from './client';
import { arrayBufferToBase64, type ApiFile } from './files';

// Backend: premium AI recognition endpoints (see docs/sfs_api.md and
// api/routes/recognition.go). All calls are Bearer-authenticated by the
// shared axios client.

export type RecognitionKind = 'face' | 'pet' | 'object';

export interface RecognitionJobCounts {
  pending: number;
  processing: number;
  done: number;
  failed: number;
  skipped: number;
}

export interface RecognitionStatus {
  enabled: boolean;
  service_available: boolean;
  counts: RecognitionJobCounts;
  groups: { face: number; pet: number; object: number };
  storage_bytes: number;
}

export interface RecognitionGroup {
  id: string;
  collection_id: string;
  kind: RecognitionKind;
  class_label?: string;
  auto_label: string;
  user_label?: string;
  file_count: number;
  cover_detection_id?: string;
  cover_file_id?: string;
}

export interface RecognitionGroupSearchHit {
  id: string;
  collection_id: string;
  collection_name: string;
  kind: RecognitionKind;
  label: string;
  file_count: number;
  cover_detection_id?: string;
  cover_file_id?: string;
}

// Backend: GET /collections/:id/recognition
export async function getRecognitionStatus(collectionID: string): Promise<RecognitionStatus> {
  const res = await api.get<RecognitionStatus>(`/api/v1/collections/${collectionID}/recognition`);
  return res.data;
}

// Backend: PUT /collections/:id/recognition
export async function setRecognitionEnabled(
  collectionID: string,
  enabled: boolean,
  purge = false,
): Promise<{ enabled: boolean; files_enqueued: number; freed_bytes: number }> {
  const res = await api.put(`/api/v1/collections/${collectionID}/recognition`, { enabled, purge });
  return res.data;
}

// Backend: GET /collections/:id/recognition/groups
export async function listRecognitionGroups(
  collectionID: string,
  kind?: RecognitionKind,
  labeled?: boolean,
): Promise<RecognitionGroup[]> {
  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  if (labeled) params.set('labeled', 'true');
  const qs = params.toString();
  const res = await api.get<{ groups: RecognitionGroup[] }>(
    `/api/v1/collections/${collectionID}/recognition/groups${qs ? `?${qs}` : ''}`,
  );
  return res.data.groups ?? [];
}

// Backend: GET /recognition/groups/:id/files
export async function getGroupFiles(
  groupID: string,
  cursor?: string,
): Promise<{ items: ApiFile[]; next_token?: string }> {
  const qs = cursor ? `?file_cursor=${encodeURIComponent(cursor)}` : '';
  const res = await api.get(`/api/v1/recognition/groups/${groupID}/files${qs}`);
  return res.data;
}

// Backend: PATCH /recognition/groups/:id — empty label clears back to auto.
export async function renameGroup(groupID: string, label: string): Promise<RecognitionGroup> {
  const res = await api.patch(`/api/v1/recognition/groups/${groupID}`, { label });
  return res.data;
}

// Backend: POST /recognition/groups/:id/merge
export async function mergeGroups(targetGroupID: string, sourceGroupIDs: string[]): Promise<RecognitionGroup> {
  const res = await api.post(`/api/v1/recognition/groups/${targetGroupID}/merge`, {
    source_group_ids: sourceGroupIDs,
  });
  return res.data;
}

// Backend: DELETE /recognition/groups/:id
export async function deleteGroup(groupID: string): Promise<void> {
  await api.delete(`/api/v1/recognition/groups/${groupID}`);
}

// Backend: GET /recognition/detections/:id/thumb — returns a data URI (the
// same authed-fetch-to-base64 approach downloadFile uses for previews).
export async function downloadRecognitionThumb(detectionID: string): Promise<string> {
  const res = await api.get(`/api/v1/recognition/detections/${detectionID}/thumb`, {
    responseType: 'arraybuffer',
  });
  return `data:image/jpeg;base64,${arrayBufferToBase64(res.data as ArrayBuffer)}`;
}

// Backend: GET /search — files plus labeled recognition groups (premium).
export async function searchWithGroups(query: string): Promise<{
  files: ApiFile[];
  groups: RecognitionGroupSearchHit[];
}> {
  const res = await api.get(
    `/api/v1/search?q=${encodeURIComponent(query)}&folder_limit=0&file_limit=20`,
  );
  return {
    files: res.data.files?.items ?? [],
    groups: res.data.recognition_groups?.items ?? [],
  };
}
