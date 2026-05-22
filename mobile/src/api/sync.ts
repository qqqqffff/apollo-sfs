import api from './client';
import { ApiFile } from './files';

export interface DeltaResponse {
  files: ApiFile[];
  deleted_ids: string[];
  server_time: string;
}

export async function registerDevice(
  name: string,
  platform: 'ios' | 'android',
  pushToken?: string,
): Promise<{ id: string }> {
  const res = await api.post('/api/v1/devices', { name, platform, push_token: pushToken });
  return res.data;
}

export async function deleteDevice(deviceID: string): Promise<void> {
  await api.delete(`/api/v1/devices/${deviceID}`);
}

export async function deltaSync(since: string, deviceID?: string): Promise<DeltaResponse> {
  const params: Record<string, string> = { since };
  if (deviceID) params.device_id = deviceID;
  const res = await api.get<DeltaResponse>('/api/v1/sync/delta', { params });
  return res.data;
}

export async function checkHash(sha256Hash: string): Promise<{ exists: boolean; file_id?: string }> {
  const res = await api.post('/api/v1/sync/check-hash', { sha256_hash: sha256Hash });
  return res.data;
}
