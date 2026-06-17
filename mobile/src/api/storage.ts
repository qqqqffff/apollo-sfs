import api from './client';

export interface ServerInfo {
  id: string;
  name: string;
  state: string;
  total_capacity_bytes: number;
  available_bytes: number;
  ping_url: string;
  drive_type: 'nvme' | 'hdd';
}

export interface ServerInfoWithPing extends ServerInfo {
  ping_ms: number | null;
}

export interface StorageBreakdown {
  used_bytes: number;
  quota_bytes: number;
  nvme_bytes: number;
  hdd_bytes: number;
  server: {
    id: string;
    name: string;
    state: string;
    drive_label: string;
    ping_url: string;
  } | null;
}

export interface SpeedMetrics {
  ping_ms: number | null;
  download_mbps: number | null;
  upload_mbps: number | null;
}

// Backend: GET /api/v1/storage/servers
export async function listServers(): Promise<ServerInfo[]> {
  const res = await api.get<{ servers: ServerInfo[] }>('/api/v1/storage/servers');
  return res.data.servers ?? [];
}

// Measures round-trip latency to a server via its ping_url.
export async function pingServer(pingUrl: string): Promise<number> {
  const start = Date.now();
  await api.get(pingUrl);
  return Date.now() - start;
}

// Fetches server list and measures ping to each in parallel, then sorts by latency.
export async function listServersWithPing(): Promise<ServerInfoWithPing[]> {
  const servers = await listServers();
  const results = await Promise.all(
    servers.map(async (s): Promise<ServerInfoWithPing> => {
      try {
        const ping_ms = await pingServer(s.ping_url);
        return { ...s, ping_ms };
      } catch {
        return { ...s, ping_ms: null };
      }
    }),
  );
  return results.sort((a, b) => {
    if (a.ping_ms === null) return 1;
    if (b.ping_ms === null) return -1;
    return a.ping_ms - b.ping_ms;
  });
}

// Backend: GET /api/v1/storage/breakdown
export async function getStorageBreakdown(): Promise<StorageBreakdown> {
  const res = await api.get<StorageBreakdown>('/api/v1/storage/breakdown');
  return res.data;
}

// Backend: GET /api/v1/storage/speed/download
// Downloads a 1 MiB test payload and returns measured throughput in Mbps.
export async function measureDownloadSpeed(): Promise<number> {
  const start = Date.now();
  await api.get('/api/v1/storage/speed/download', { responseType: 'arraybuffer' });
  const elapsedSec = (Date.now() - start) / 1000;
  return (1 / elapsedSec) * 8; // 1 MiB → Mbps
}

// Backend: POST /api/v1/storage/speed/upload
// Uploads a 512 KiB payload and returns measured throughput in Mbps.
export async function measureUploadSpeed(): Promise<number> {
  const buf = new ArrayBuffer(512 * 1024); // 512 KiB
  const start = Date.now();
  await api.post('/api/v1/storage/speed/upload', buf, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  const elapsedSec = (Date.now() - start) / 1000;
  return (0.5 / elapsedSec) * 8; // 512 KiB → Mbps
}

// Runs a full speed measurement (ping + download + upload) against the user's server.
// Throws with { code: 'RATE_LIMITED' } if the server rejects due to rate limit.
export async function runSpeedTest(pingUrl: string): Promise<SpeedMetrics> {
  const ping_ms = await pingServer(pingUrl).catch(() => null);

  let download_mbps: number | null = null;
  let upload_mbps: number | null = null;

  try {
    download_mbps = await measureDownloadSpeed();
  } catch (e: any) {
    if (e?.response?.status === 429) {
      const err: any = new Error('Rate limit exceeded');
      err.code = 'RATE_LIMITED';
      throw err;
    }
  }

  try {
    upload_mbps = await measureUploadSpeed();
  } catch (e: any) {
    if (e?.response?.status === 429) {
      const err: any = new Error('Rate limit exceeded');
      err.code = 'RATE_LIMITED';
      throw err;
    }
  }

  return { ping_ms, download_mbps, upload_mbps };
}
