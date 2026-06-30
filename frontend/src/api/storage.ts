import { get, put } from './client'

export interface StorageBreakdown {
  used_bytes: number
  quota_bytes: number
  nvme_bytes: number
  hdd_bytes: number
  server: {
    id: string
    name: string
    state: string
    drive_label: string
    ping_url: string
  } | null
}

export interface SpeedMetrics {
  ping_ms: number | null
  download_mbps: number | null
  upload_mbps: number | null
}

export interface MyServer {
  server_id: string
  drive_id: string
  name: string
  state: string
  drive_type: 'nvme' | 'hdd'
  capacity_bytes: number
  used_bytes: number
  drive_used_pct: number
  is_primary: boolean
  ping_url: string
}

export async function getStorageBreakdown(): Promise<StorageBreakdown> {
  return get<StorageBreakdown>('/storage/breakdown')
}

export async function listMyServers(): Promise<MyServer[]> {
  const res = await get<{ servers: MyServer[] }>('/storage/my-servers')
  return res.servers ?? []
}

export async function setPrimaryServer(serverId: string): Promise<void> {
  return put<void>('/storage/primary-server', { server_id: serverId })
}

export async function pingServer(pingUrl: string): Promise<number> {
  const start = Date.now()
  await fetch(pingUrl, { credentials: 'include' })
  return Date.now() - start
}

export async function measureDownloadSpeed(): Promise<number> {
  const start = Date.now()
  const res = await fetch('/api/v1/storage/speed/download', { credentials: 'include' })
  if (res.status === 429) {
    const err: any = new Error('Rate limited')
    err.code = 'RATE_LIMITED'
    throw err
  }
  await res.arrayBuffer()
  const elapsedSec = (Date.now() - start) / 1000
  return (1 / elapsedSec) * 8
}

export async function measureUploadSpeed(): Promise<number> {
  const buf = new ArrayBuffer(512 * 1024)
  const start = Date.now()
  const res = await fetch('/api/v1/storage/speed/upload', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf,
  })
  if (res.status === 429) {
    const err: any = new Error('Rate limited')
    err.code = 'RATE_LIMITED'
    throw err
  }
  const elapsedSec = (Date.now() - start) / 1000
  return (0.5 / elapsedSec) * 8
}

export async function runSpeedTest(pingUrl: string): Promise<SpeedMetrics> {
  const ping_ms = await pingServer(pingUrl).catch(() => null)
  let download_mbps: number | null = null
  let upload_mbps: number | null = null
  try {
    download_mbps = await measureDownloadSpeed()
  } catch (e: any) {
    if (e?.code === 'RATE_LIMITED') throw e
  }
  try {
    upload_mbps = await measureUploadSpeed()
  } catch (e: any) {
    if (e?.code === 'RATE_LIMITED') throw e
  }
  return { ping_ms, download_mbps, upload_mbps }
}
