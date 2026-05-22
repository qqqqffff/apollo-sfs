import SQLite from 'react-native-sqlite-storage';

SQLite.enablePromise(true);

export type UploadStatus = 'pending' | 'uploading' | 'done' | 'failed';

export interface QueueItem {
  local_asset_id: string;
  local_uri: string;
  filename: string;
  sha256_hash: string | null;
  size_bytes: number | null;
  mime_type: string | null;
  status: UploadStatus;
  upload_id: string | null;
  retry_count: number;
  created_at: number;
  updated_at: number;
}

let db: SQLite.SQLiteDatabase | null = null;

async function getDB(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabase({ name: 'apollo_upload_queue.db', location: 'default' });
  await db.executeSql(`
    CREATE TABLE IF NOT EXISTS upload_queue (
      local_asset_id TEXT PRIMARY KEY,
      local_uri      TEXT NOT NULL,
      filename       TEXT NOT NULL,
      sha256_hash    TEXT,
      size_bytes     INTEGER,
      mime_type      TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      upload_id      TEXT,
      retry_count    INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
  `);
  return db;
}

export async function enqueue(
  item: Omit<QueueItem, 'status' | 'upload_id' | 'retry_count' | 'created_at' | 'updated_at'>,
): Promise<void> {
  const d = await getDB();
  const now = Date.now();
  await d.executeSql(
    `INSERT OR IGNORE INTO upload_queue
       (local_asset_id, local_uri, filename, sha256_hash, size_bytes, mime_type, status, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    [
      item.local_asset_id,
      item.local_uri,
      item.filename,
      item.sha256_hash ?? null,
      item.size_bytes ?? null,
      item.mime_type ?? null,
      now,
      now,
    ],
  );
}

export async function getPendingItems(limit = 20): Promise<QueueItem[]> {
  const d = await getDB();
  const [results] = await d.executeSql(
    `SELECT * FROM upload_queue WHERE status = 'pending' OR status = 'failed' ORDER BY created_at ASC LIMIT ?`,
    [limit],
  );
  const items: QueueItem[] = [];
  for (let i = 0; i < results.rows.length; i++) {
    items.push(results.rows.item(i) as QueueItem);
  }
  return items;
}

export async function setStatus(
  localAssetID: string,
  status: UploadStatus,
  uploadID?: string,
): Promise<void> {
  const d = await getDB();
  await d.executeSql(
    `UPDATE upload_queue SET status = ?, upload_id = COALESCE(?, upload_id), updated_at = ? WHERE local_asset_id = ?`,
    [status, uploadID ?? null, Date.now(), localAssetID],
  );
}

export async function incrementRetry(localAssetID: string): Promise<void> {
  const d = await getDB();
  await d.executeSql(
    `UPDATE upload_queue SET retry_count = retry_count + 1, status = 'failed', updated_at = ? WHERE local_asset_id = ?`,
    [Date.now(), localAssetID],
  );
}

export async function countByStatus(status: UploadStatus): Promise<number> {
  const d = await getDB();
  const [results] = await d.executeSql(
    `SELECT COUNT(*) as count FROM upload_queue WHERE status = ?`,
    [status],
  );
  return (results.rows.item(0) as { count: number }).count ?? 0;
}

export async function isAlreadyDone(localAssetID: string): Promise<boolean> {
  const d = await getDB();
  const [results] = await d.executeSql(
    `SELECT status FROM upload_queue WHERE local_asset_id = ?`,
    [localAssetID],
  );
  if (results.rows.length === 0) return false;
  return (results.rows.item(0) as { status: string }).status === 'done';
}
