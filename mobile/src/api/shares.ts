import api, { BASE_URL } from './client';
import type { ApiFolder } from './files';

// Mirrors the backend ShareInfo: a grant giving one recipient (matched by
// account email) access to a single file or a folder subtree.
export interface Share {
  id: string;
  owner_user_id: string;
  recipient_email: string;
  file_id: string | null;
  folder_id: string | null;
  can_download: boolean;
  can_upload: boolean;
  include_children: boolean;
  revoked_at: string | null;
  created_at: string;
  item_type: 'file' | 'folder';
  item_name: string;
  item_size_bytes: number;
  item_mime_type?: string;
  owner_email?: string;
  share_url: string;
}

export interface SharedFile {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export interface SharedContents {
  folder: ApiFolder | null;
  subfolders: { items: ApiFolder[]; next_token: string };
  files: { items: SharedFile[]; next_token: string };
}

export async function listMyShares(): Promise<Share[]> {
  const res = await api.get<{ shares: Share[] }>('/api/v1/shares');
  return res.data.shares ?? [];
}

export async function listSharedWithMe(): Promise<Share[]> {
  const res = await api.get<{ shares: Share[] }>('/api/v1/shares/shared-with-me');
  return res.data.shares ?? [];
}

export async function revokeShare(shareId: string): Promise<void> {
  await api.delete(`/api/v1/shares/${shareId}`);
}

// List a shared folder's children. folderId navigates into a descendant.
export async function getSharedContents(shareId: string, folderId?: string | null): Promise<SharedContents> {
  const qs = folderId ? `?folder_id=${folderId}` : '';
  const res = await api.get<SharedContents>(`/api/v1/shares/${shareId}/contents${qs}`);
  return res.data;
}

export function sharedDownloadUrl(shareId: string, fileId?: string | null): string {
  const qs = fileId ? `?file_id=${fileId}` : '';
  return `${BASE_URL}/api/v1/shares/${shareId}/file/download${qs}`;
}
