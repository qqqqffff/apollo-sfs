import { post, uploadWithProgress } from './client'
import type { UploadResponse } from '../types/api'

const DRIVE_API         = 'https://www.googleapis.com/drive/v3'
const PHOTOS_PICKER_API = 'https://photospicker.googleapis.com/v1'
const MAX_DRIVE_FILES   = 500
const GOOGLE_CLIENT_ID  = '550302272436-0l08i22en4eifho0msrr07lkqr0t5ouj.apps.googleusercontent.com'
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
].join(' ')

// ── Public types ──────────────────────────────────────────────────────────────

export interface GoogleBackupItem {
  id: string
  name: string
  mimeType: string
  size: number | null          // null for Photos and Google Workspace files
  modifiedTime: string
  source: 'drive' | 'photos'
  isGoogleDoc: boolean         // true = Workspace file, export as PDF
  baseUrl: string | null       // Photos only
  thumbnailLink: string | null // Drive only, pre-signed (no auth needed)
}

export interface PhotosPickerSession {
  id: string
  pickerUri: string
  pollIntervalMs: number
  timeoutMs: number
  mediaItemsSet: boolean
}

export interface BackupEntry {
  googleItem: GoogleBackupItem
  name: string
  type: string
  destFolderId: string | null
}

export type BackupItemStatus = 'done' | 'duplicate' | 'error'

export interface BackupResult {
  uploaded: number
  duplicates: number
  errors: number
}

// ── Google Identity Services ─────────────────────────────────────────────────

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string
            scope: string
            callback: (r: { access_token?: string; error?: string }) => void
          }) => { requestAccessToken: () => void }
        }
      }
    }
  }
}

function loadGIS(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return }
    const existing = document.getElementById('gis-script')
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('Failed to load Google Identity Services')))
      return
    }
    const script = document.createElement('script')
    script.id = 'gis-script'
    script.src = 'https://accounts.google.com/gsi/client'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'))
    document.head.appendChild(script)
  })
}

export async function requestGoogleAccessToken(): Promise<string> {
  await loadGIS()
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: (r) => {
        if (r.error || !r.access_token) reject(new Error(r.error ?? 'No access token'))
        else resolve(r.access_token!)
      },
    })
    client.requestAccessToken()
  })
}

// ── Fetch helper ──────────────────────────────────────────────────────────────

async function gFetch(url: string, accessToken: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status}: ${body}`)
  }
  return res.json()
}

function parseDurationMs(d: string | undefined, fallback: number): number {
  if (!d) return fallback
  const n = parseFloat(String(d).replace('s', ''))
  return Number.isFinite(n) ? Math.round(n * 1000) : fallback
}

// ── Google Drive listing ──────────────────────────────────────────────────────

export async function listGoogleDriveFiles(accessToken: string): Promise<GoogleBackupItem[]> {
  const items: GoogleBackupItem[] = []
  let pageToken: string | undefined

  while (items.length < MAX_DRIVE_FILES) {
    let url =
      `${DRIVE_API}/files?pageSize=100` +
      `&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink)` +
      `&q=trashed%3Dfalse+and+mimeType+!%3D+%27application%2Fvnd.google-apps.folder%27`
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`

    const data = await gFetch(url, accessToken)
    for (const f of data.files ?? []) {
      items.push({
        id:           f.id,
        name:         f.name,
        mimeType:     f.mimeType,
        size:         f.size != null ? Number(f.size) : null,
        modifiedTime: f.modifiedTime ?? '',
        source:       'drive',
        isGoogleDoc:  String(f.mimeType).startsWith('application/vnd.google-apps.'),
        baseUrl:      null,
        thumbnailLink: f.thumbnailLink ?? null,
      })
    }
    if (!data.nextPageToken) break
    pageToken = data.nextPageToken
  }

  return items
}

// ── Google Photos (Picker API) ────────────────────────────────────────────────
// photoslibrary.readonly was removed by Google on 2025-03-31. The Photos Picker
// API is now the only supported way to read user photos.

function toSession(data: any): PhotosPickerSession {
  return {
    id:             data.id,
    pickerUri:      data.pickerUri,
    pollIntervalMs: parseDurationMs(data.pollingConfig?.pollInterval, 3000),
    timeoutMs:      parseDurationMs(data.pollingConfig?.timeoutIn, 300000),
    mediaItemsSet:  Boolean(data.mediaItemsSet),
  }
}

export async function createPhotosPickerSession(accessToken: string): Promise<PhotosPickerSession> {
  const res = await fetch(`${PHOTOS_PICKER_API}/sessions`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    '{}',
  })
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => '')}`)
  return toSession(await res.json())
}

export async function getPhotosPickerSession(sessionId: string, accessToken: string): Promise<PhotosPickerSession> {
  return toSession(await gFetch(`${PHOTOS_PICKER_API}/sessions/${sessionId}`, accessToken))
}

export async function deletePhotosPickerSession(sessionId: string, accessToken: string): Promise<void> {
  await fetch(`${PHOTOS_PICKER_API}/sessions/${sessionId}`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  }).catch(() => undefined)
}

export async function listPickedPhotos(sessionId: string, accessToken: string): Promise<GoogleBackupItem[]> {
  const items: GoogleBackupItem[] = []
  let pageToken: string | undefined

  do {
    let url = `${PHOTOS_PICKER_API}/mediaItems?sessionId=${encodeURIComponent(sessionId)}&pageSize=100`
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`

    const data = await gFetch(url, accessToken)
    for (const m of data.mediaItems ?? []) {
      const mf = m.mediaFile ?? {}
      items.push({
        id:           m.id,
        name:         mf.filename ?? 'photo',
        mimeType:     mf.mimeType ?? 'application/octet-stream',
        size:         null,
        modifiedTime: m.createTime ?? '',
        source:       'photos',
        isGoogleDoc:  false,
        baseUrl:      mf.baseUrl ?? null,
        thumbnailLink: null,
      })
    }
    pageToken = data.nextPageToken
  } while (pageToken)

  return items
}

// Opens the Photos Picker in a browser popup. The popup shares the user's
// Google session cookies naturally, so no re-authentication is needed.
// Polls the session in the background until selection is complete or timed out.
export async function pickGooglePhotosWeb(accessToken: string): Promise<GoogleBackupItem[]> {
  let session: PhotosPickerSession
  try {
    session = await createPhotosPickerSession(accessToken)
  } catch { return [] }

  const popup = window.open(
    session.pickerUri,
    'google-photos-picker',
    'width=720,height=640,left=200,top=100,menubar=no,toolbar=no,resizable=yes',
  )

  const deadline = Date.now() + session.timeoutMs
  let current = session

  while (!current.mediaItemsSet && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, current.pollIntervalMs))
    if (popup?.closed) break
    try { current = await getPhotosPickerSession(session.id, accessToken) } catch { break }
  }

  popup?.close()

  if (current.mediaItemsSet) {
    try {
      const picked = await listPickedPhotos(session.id, accessToken)
      await deletePhotosPickerSession(session.id, accessToken)
      return picked
    } catch { return [] }
  }

  await deletePhotosPickerSession(session.id, accessToken).catch(() => {})
  return []
}

// ── Delete (Drive only) ───────────────────────────────────────────────────────

export async function deleteGoogleDriveFile(fileId: string, accessToken: string): Promise<void> {
  const res = await fetch(`${DRIVE_API}/files/${fileId}`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok && res.status !== 204) throw new Error(`Delete failed: ${res.status}`)
}

export async function trashGoogleDriveFiles(
  fileIds: string[],
  accessToken: string,
): Promise<{ failed: number }> {
  let failed = 0
  for (const id of fileIds) {
    try { await deleteGoogleDriveFile(id, accessToken) }
    catch { failed++ }
  }
  return { failed }
}

// ── Preview ───────────────────────────────────────────────────────────────────

// Drive: thumbnailLink is a pre-signed URL; no Authorization header needed.
// Photos: baseUrl requires an Authorization header, so we fetch it as a blob
// and return an object URL. The caller is responsible for revoking it.
export function drivePreviewUrl(item: GoogleBackupItem): string | null {
  if (item.source !== 'drive' || !item.mimeType.startsWith('image/')) return null
  return item.thumbnailLink
}

export async function photosPreviewBlobUrl(
  item: GoogleBackupItem,
  accessToken: string,
): Promise<string | null> {
  if (item.source !== 'photos' || !item.baseUrl || !item.mimeType.startsWith('image/')) return null
  try {
    const res = await fetch(`${item.baseUrl}=w512-h512`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    return URL.createObjectURL(await res.blob())
  } catch { return null }
}

// ── Dedup + upload ────────────────────────────────────────────────────────────

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function downloadGoogleBlob(item: GoogleBackupItem, accessToken: string): Promise<Blob> {
  let url: string

  if (item.source === 'photos' && item.baseUrl) {
    url = item.mimeType.startsWith('video/') ? `${item.baseUrl}=dv` : `${item.baseUrl}=d`
  } else if (item.isGoogleDoc) {
    url = `${DRIVE_API}/files/${item.id}/export?mimeType=application%2Fpdf`
  } else {
    url = `${DRIVE_API}/files/${item.id}?alt=media`
  }

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`Download failed: ${res.status}`)
  return res.blob()
}

function sourceFor(item: GoogleBackupItem): string {
  return item.source === 'photos' ? 'google_photos' : 'google_drive'
}

export async function uploadGoogleEntries(
  entries: BackupEntry[],
  accessToken: string,
  onProgress?: (
    done: number,
    total: number,
    finished?: { entry: BackupEntry; status: BackupItemStatus },
  ) => void,
): Promise<BackupResult> {
  const total = entries.length
  let uploaded = 0, duplicates = 0, errors = 0

  for (let i = 0; i < total; i++) {
    const e = entries[i]
    let status: BackupItemStatus = 'error'

    try {
      const blob   = await downloadGoogleBlob(e.googleItem, accessToken)
      const buffer = await blob.arrayBuffer()
      const hash   = await sha256Hex(buffer)

      let isDuplicate = false
      try {
        const { exists } = await post<{ exists: boolean }>('/sync/check-hash', { sha256_hash: hash })
        isDuplicate = exists
      } catch { /* non-fatal */ }

      if (isDuplicate) {
        duplicates++
        status = 'duplicate'
      } else {
        const file = new File([blob], e.name, { type: e.type })
        const form = new FormData()
        form.append('file', file)
        if (e.destFolderId) form.append('folder_id', e.destFolderId)
        form.append('source', sourceFor(e.googleItem))
        await uploadWithProgress<UploadResponse>('/files/upload', form, () => {})
        uploaded++
        status = 'done'
      }
    } catch {
      errors++
      status = 'error'
    }

    onProgress?.(i + 1, total, { entry: e, status })
  }

  return { uploaded, duplicates, errors }
}

// ── Backup settings (localStorage) ───────────────────────────────────────────

const BG_KEY = 'apollo_gbackup_background'

export function loadBackupBackground(): boolean {
  const v = localStorage.getItem(BG_KEY)
  return v === null ? true : v === 'true'
}

export function saveBackupBackground(v: boolean) {
  localStorage.setItem(BG_KEY, String(v))
}
