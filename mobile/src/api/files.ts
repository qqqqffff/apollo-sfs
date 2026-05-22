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

export interface FolderContents {
  folder: unknown;
  subfolders: { items: unknown[]; next_token?: string };
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

export async function downloadFile(fileID: string): Promise<string> {
  const res = await api.post<{ url: string }>(`/api/v1/files/${fileID}/presign`);
  return res.data.url;
}

export async function deleteFile(fileID: string): Promise<void> {
  await api.delete(`/api/v1/files/${fileID}`);
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
