import api from './client';

export interface ApiFile {
  id: string;
  user_id: string;
  folder_id: string | null;
  name: string;
  mime_type: string;
  size_bytes: number;
  sha256_hash?: string;
  taken_at?: string;
  hidden: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiFolder {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  kind: 'regular' | 'media';
  created_at: string;
  updated_at: string;
}

export interface FolderContents {
  folder: ApiFolder | null;
  subfolders: { items: ApiFolder[]; next_token?: string };
  files: { items: ApiFile[]; next_token?: string };
}

export async function listRoot(): Promise<FolderContents> {
  const res = await api.get<FolderContents>('/api/v1/folders');
  return res.data;
}

export async function getFolder(folderID: string): Promise<FolderContents> {
  const res = await api.get<FolderContents>(`/api/v1/folders/${folderID}`);
  return res.data;
}

export async function uploadFile(
  uri: string,
  name: string,
  mimeType: string,
  folderID?: string,
  onProgress?: (pct: number) => void,
): Promise<ApiFile> {
  const form = new FormData();
  form.append('file', { uri, name, type: mimeType } as unknown as Blob);
  if (folderID) form.append('folder_id', folderID);

  const res = await api.post<ApiFile>('/api/v1/files/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
    },
  });
  return res.data;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 4096) {
    chunks.push(String.fromCharCode(...Array.from(bytes.subarray(i, i + 4096))));
  }
  return btoa(chunks.join(''));
}

export async function downloadFile(fileID: string): Promise<string> {
  const res = await api.get(`/api/v1/files/${fileID}/preview`, {
    responseType: 'arraybuffer',
  });
  const mime = ((res.headers['content-type'] as string | undefined) ?? 'image/jpeg')
    .split(';')[0]
    .trim();
  return `data:${mime};base64,${arrayBufferToBase64(res.data as ArrayBuffer)}`;
}

export async function deleteFile(fileID: string): Promise<void> {
  await api.delete(`/api/v1/files/${fileID}`);
}

export async function moveFile(fileID: string, folderID: string): Promise<ApiFile> {
  const res = await api.patch<ApiFile>(`/api/v1/files/${fileID}/move`, { folder_id: folderID });
  return res.data;
}

export async function createFolder(
  name: string,
  parentID?: string,
  kind: 'regular' | 'media' = 'regular',
): Promise<ApiFolder> {
  const res = await api.post<ApiFolder>('/api/v1/folders', {
    name,
    parent_id: parentID ?? null,
    kind,
  });
  return res.data;
}

export async function deleteFolder(folderID: string): Promise<void> {
  await api.delete(`/api/v1/folders/${folderID}`);
}

export interface UserPreferences {
  media_autoupload_folder_id: string | null;
}

export async function getPreferences(): Promise<UserPreferences> {
  const res = await api.get<UserPreferences>('/api/v1/me/preferences');
  return res.data;
}

export async function updatePreferences(prefs: Partial<UserPreferences>): Promise<UserPreferences> {
  const res = await api.put<UserPreferences>('/api/v1/me/preferences', prefs);
  return res.data;
}

export async function listFavorites() {
  const res = await api.get('/api/v1/favorites');
  return res.data;
}

export async function favoriteFile(fileID: string): Promise<void> {
  await api.post(`/api/v1/favorites/files/${fileID}`);
}

export async function unfavoriteFile(fileID: string): Promise<void> {
  await api.delete(`/api/v1/favorites/files/${fileID}`);
}
