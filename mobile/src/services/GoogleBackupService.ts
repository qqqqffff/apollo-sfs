import RNBlobUtil from 'react-native-blob-util';

const DRIVE_API   = 'https://www.googleapis.com/drive/v3';
const PHOTOS_API  = 'https://photoslibrary.googleapis.com/v1';
const MAX_PER_SOURCE = 500;

// ── Public types ──────────────────────────────────────────────────────────────

export interface GoogleBackupItem {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;       // null for Photos and Google Workspace files
  modifiedTime: string;
  source: 'drive' | 'photos';
  isGoogleDoc: boolean;      // true = Workspace file, export as PDF
  baseUrl: string | null;    // Photos only
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

// ── File listing ──────────────────────────────────────────────────────────────

export async function listGoogleFiles(accessToken: string): Promise<GoogleBackupItem[]> {
  const items: GoogleBackupItem[] = [];

  // ── Google Drive ──────────────────────────────────────────────────────────
  let driveToken: string | undefined;
  while (items.filter((i) => i.source === 'drive').length < MAX_PER_SOURCE) {
    let url =
      `${DRIVE_API}/files?pageSize=100` +
      `&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)` +
      `&q=trashed%3Dfalse+and+mimeType+!%3D+%27application%2Fvnd.google-apps.folder%27`;
    if (driveToken) url += `&pageToken=${encodeURIComponent(driveToken)}`;

    const data = await gFetch(url, accessToken);
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
      });
    }
    if (!data.nextPageToken) break;
    driveToken = data.nextPageToken;
  }

  // ── Google Photos ─────────────────────────────────────────────────────────
  let photosToken: string | undefined;
  while (items.filter((i) => i.source === 'photos').length < MAX_PER_SOURCE) {
    let url = `${PHOTOS_API}/mediaItems?pageSize=100`;
    if (photosToken) url += `&pageToken=${encodeURIComponent(photosToken)}`;

    const data = await gFetch(url, accessToken);
    for (const m of data.mediaItems ?? []) {
      items.push({
        id:           m.id,
        name:         m.filename,
        mimeType:     m.mimeType,
        size:         null,  // Photos API does not return file size
        modifiedTime: m.mediaMetadata?.creationTime ?? '',
        source:       'photos',
        isGoogleDoc:  false,
        baseUrl:      m.baseUrl ?? null,
      });
    }
    if (!data.nextPageToken) break;
    photosToken = data.nextPageToken;
  }

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
    // Photos baseUrl is a pre-signed URL — no auth header needed
    downloadUrl = `${item.baseUrl}=d`;
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
