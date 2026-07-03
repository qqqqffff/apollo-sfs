import RNBlobUtil from 'react-native-blob-util';
import { uploadFile } from '../api/files';
import { checkHash } from '../api/sync';

const DRIVE_API         = 'https://www.googleapis.com/drive/v3';
const PHOTOS_PICKER_API = 'https://photospicker.googleapis.com/v1';
const MAX_DRIVE_FILES   = 500;

// ── Public types ──────────────────────────────────────────────────────────────

export interface GoogleBackupItem {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;          // null for Photos and Google Workspace files
  modifiedTime: string;
  source: 'drive' | 'photos';
  isGoogleDoc: boolean;         // true = Workspace file, export as PDF
  baseUrl: string | null;       // Photos only
  thumbnailLink: string | null; // Drive only, time-limited pre-signed URL
}

export interface PhotosPickerSession {
  id: string;
  pickerUri: string;         // open this in a browser for the user to pick photos
  pollIntervalMs: number;    // how long to wait between sessions.get polls
  timeoutMs: number;         // give up polling after this long
  mediaItemsSet: boolean;    // true once the user has finished selecting
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function gFetch(url: string, accessToken: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json();
}

// "5s", "2.500s" → milliseconds. Falls back when the field is absent.
function parseDurationMs(d: string | undefined, fallback: number): number {
  if (!d) return fallback;
  const n = parseFloat(String(d).replace('s', ''));
  return Number.isFinite(n) ? Math.round(n * 1000) : fallback;
}

// ── Google Drive listing ──────────────────────────────────────────────────────

export async function listGoogleDriveFiles(accessToken: string): Promise<GoogleBackupItem[]> {
  const items: GoogleBackupItem[] = [];
  let pageToken: string | undefined;

  while (items.length < MAX_DRIVE_FILES) {
    let url =
      `${DRIVE_API}/files?pageSize=100` +
      `&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink)` +
      `&q=trashed%3Dfalse+and+mimeType+!%3D+%27application%2Fvnd.google-apps.folder%27`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

    const data = await gFetch(url, accessToken);
    for (const f of data.files ?? []) {
      items.push({
        id:           f.id,
        name:         f.name,
        mimeType:     f.mimeType,
        size:          f.size != null ? Number(f.size) : null,
        modifiedTime:  f.modifiedTime ?? '',
        source:        'drive',
        isGoogleDoc:   String(f.mimeType).startsWith('application/vnd.google-apps.'),
        baseUrl:       null,
        thumbnailLink: f.thumbnailLink ?? null,
      });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return items;
}

// ── Google Photos (Picker API) ────────────────────────────────────────────────
//
// As of 2025-03-31 Google removed the photoslibrary.readonly scope and the
// library-wide mediaItems.list endpoint now returns 403 "insufficient
// authentication scopes". The only supported way to read a user's existing
// photos is the Photos Picker API: create a session, send the user to
// session.pickerUri to choose photos, poll until they're done, then list the
// items they picked.

function toSession(data: any): PhotosPickerSession {
  return {
    id:             data.id,
    pickerUri:      data.pickerUri,
    pollIntervalMs: parseDurationMs(data.pollingConfig?.pollInterval, 3000),
    timeoutMs:      parseDurationMs(data.pollingConfig?.timeoutIn, 300000),
    mediaItemsSet:  Boolean(data.mediaItemsSet),
  };
}

export async function createPhotosPickerSession(accessToken: string): Promise<PhotosPickerSession> {
  const res = await fetch(`${PHOTOS_PICKER_API}/sessions`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    '{}',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${body}`);
  }
  return toSession(await res.json());
}

export async function getPhotosPickerSession(
  sessionId: string,
  accessToken: string,
): Promise<PhotosPickerSession> {
  return toSession(await gFetch(`${PHOTOS_PICKER_API}/sessions/${sessionId}`, accessToken));
}

// Best-effort cleanup. Frees the session so the picked items can't be re-listed.
export async function deletePhotosPickerSession(sessionId: string, accessToken: string): Promise<void> {
  await fetch(`${PHOTOS_PICKER_API}/sessions/${sessionId}`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  }).catch(() => undefined);
}

export async function listPickedPhotos(
  sessionId: string,
  accessToken: string,
): Promise<GoogleBackupItem[]> {
  const items: GoogleBackupItem[] = [];
  let pageToken: string | undefined;

  do {
    let url = `${PHOTOS_PICKER_API}/mediaItems?sessionId=${encodeURIComponent(sessionId)}&pageSize=100`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

    const data = await gFetch(url, accessToken);
    for (const m of data.mediaItems ?? []) {
      const mf = m.mediaFile ?? {};
      items.push({
        id:           m.id,
        name:         mf.filename ?? 'photo',
        mimeType:     mf.mimeType ?? 'application/octet-stream',
        size:         null,  // Picker API does not return file size
        modifiedTime: m.createTime ?? '',
        source:        'photos',
        isGoogleDoc:   false,
        baseUrl:       mf.baseUrl ?? null,
        thumbnailLink: null,
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return items;
}

// ── Download ──────────────────────────────────────────────────────────────────

// Returns a local file:// URI ready for uploadFile().
export async function downloadGoogleFile(
  item: GoogleBackupItem,
  accessToken: string,
): Promise<string> {
  let downloadUrl: string;
  const headers: Record<string, string> = {};

  if (item.source === 'photos' && item.baseUrl) {
    // Picker API base URLs require a download param (=d image / =dv video) AND an
    // Authorization header — unlike the old Library API's pre-signed URLs.
    downloadUrl = item.mimeType.startsWith('video/') ? `${item.baseUrl}=dv` : `${item.baseUrl}=d`;
    headers.Authorization = `Bearer ${accessToken}`;
  } else if (item.isGoogleDoc) {
    // Workspace files must be exported (PDF is universally readable)
    downloadUrl = `${DRIVE_API}/files/${item.id}/export?mimeType=application%2Fpdf`;
    headers.Authorization = `Bearer ${accessToken}`;
  } else {
    downloadUrl = `${DRIVE_API}/files/${item.id}?alt=media`;
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const result = await RNBlobUtil.config({ fileCache: true }).fetch('GET', downloadUrl, headers);
  return `file://${result.path()}`;
}

// ── Delete (Drive only) ───────────────────────────────────────────────────────

// Moves the Drive file to trash. Google Photos deletion is not supported via API.
export async function deleteGoogleDriveFile(fileId: string, accessToken: string): Promise<void> {
  const res = await fetch(`${DRIVE_API}/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Delete failed: ${res.status}`);
  }
}

// Trashes several Drive files, tolerating individual failures. Returns the
// number that could not be trashed.
export async function trashGoogleDriveFiles(
  fileIds: string[],
  accessToken: string,
): Promise<{ failed: number }> {
  let failed = 0;
  for (const id of fileIds) {
    try { await deleteGoogleDriveFile(id, accessToken); }
    catch { failed++; }
  }
  return { failed };
}

// ── Backup loop ─────────────────────────────────────────────────────────────

// One file queued for backup: the Google source plus the resolved upload name,
// mime type, and destination folder (null = root).
export interface BackupEntry {
  googleItem:   GoogleBackupItem;
  name:         string;
  type:         string;
  destFolderId: string | null;
}

// Terminal outcome for one queued file.
export type BackupItemStatus = 'done' | 'duplicate' | 'error';

export interface BackupResult {
  uploaded:   number; // newly stored
  duplicates: number; // already in SFS, skipped
  errors:     number; // failed to download/hash/upload
}

// The Apollo SFS source tag recorded on files backed up from Google.
function sourceFor(item: GoogleBackupItem): string {
  return item.source === 'photos' ? 'google_photos' : 'google_drive';
}

// Downloads each Google file to a temp path and uploads it to Apollo SFS,
// skipping any file whose content already exists (SHA-256 dedup, matching the
// camera-roll sync). Temp files are cleaned up afterwards; individual failures
// are counted, not thrown. Shared by the modal's in-place flow and HomeScreen's
// background runner. onProgress reports each file's terminal status so callers
// can mark rows live.
export async function uploadGoogleEntries(
  entries: BackupEntry[],
  accessToken: string,
  onProgress?: (done: number, total: number, finished?: { entry: BackupEntry; status: BackupItemStatus }) => void,
): Promise<BackupResult> {
  const total = entries.length;
  let uploaded = 0;
  let duplicates = 0;
  let errors = 0;

  for (let i = 0; i < total; i++) {
    const e = entries[i];
    let localUri: string | null = null;
    let status: BackupItemStatus = 'error';
    try {
      localUri = await downloadGoogleFile(e.googleItem, accessToken);

      // Dedup: skip when SFS already holds identical content.
      let isDuplicate = false;
      try {
        const hash = await RNBlobUtil.fs.hash(localUri.replace(/^file:\/\//, ''), 'sha256');
        if (hash) isDuplicate = (await checkHash(hash)).exists;
      } catch {
        // hashing / check failure is non-fatal — fall through and upload
      }

      if (isDuplicate) {
        duplicates++;
        status = 'duplicate';
      } else {
        await uploadFile(localUri, e.name, e.type, e.destFolderId ?? undefined, undefined, undefined, sourceFor(e.googleItem));
        uploaded++;
        status = 'done';
      }
    } catch {
      errors++;
      status = 'error';
    } finally {
      // Clean up the temp file regardless of outcome.
      if (localUri) {
        try { await RNBlobUtil.fs.unlink(localUri.replace(/^file:\/\//, '')); }
        catch {}
      }
    }
    onProgress?.(i + 1, total, { entry: e, status });
  }

  return { uploaded, duplicates, errors };
}

// ── Preview ─────────────────────────────────────────────────────────────────

export interface PreviewSource { uri: string; headers: Record<string, string> }

// Returns an authenticated image source for previewing a picture, or null for
// non-image items (videos, documents, Workspace files). Photos use the Picker
// base URL sized down; Drive images stream the original via alt=media.
export function googlePreviewSource(
  item: GoogleBackupItem,
  accessToken: string,
): PreviewSource | null {
  if (!item.mimeType.startsWith('image/')) return null;
  const headers = { Authorization: `Bearer ${accessToken}` };
  if (item.source === 'photos') {
    return item.baseUrl ? { uri: `${item.baseUrl}=w1024-h1024`, headers } : null;
  }
  return { uri: `${DRIVE_API}/files/${item.id}?alt=media`, headers };
}
