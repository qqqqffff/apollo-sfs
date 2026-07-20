import api from './client';

// A premium file-server mount link, scoped to one drive (a server + storage
// tier). mount_url is the WebDAV address the user mounts as a network drive;
// connecting always additionally requires their Apollo SFS login credentials.
export interface FileServerLink {
  id: string;
  server_id: string;
  drive_id: string;
  server_name: string;
  drive_type: 'nvme' | 'hdd';
  enhanced_security: boolean;
  created_at: string;
  last_used_at: string | null;
  mount_url: string;
}

export interface CreateFileServerLinkResult {
  link: FileServerLink;
  // false when a link already existed for the chosen drive.
  created: boolean;
}

export async function listFileServerLinks(): Promise<FileServerLink[]> {
  const res = await api.get<{ items: FileServerLink[] }>('/api/v1/me/file-server-links');
  return res.data.items ?? [];
}

export async function createFileServerLink(
  driveId: string,
  enhancedSecurity: boolean,
): Promise<CreateFileServerLinkResult> {
  const res = await api.post<CreateFileServerLinkResult>('/api/v1/me/file-server-links', {
    drive_id: driveId,
    enhanced_security: enhancedSecurity,
  });
  return res.data;
}

export async function deleteFileServerLink(id: string): Promise<void> {
  await api.delete(`/api/v1/me/file-server-links/${id}`);
}
