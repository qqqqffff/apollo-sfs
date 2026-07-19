/**
 * In-memory SQLite mock for UploadQueue tests.
 *
 * All functions in UploadQueue share a single DB handle (cached at module level).
 * This mock returns the same fake DB object every time, backed by a shared `store`
 * array. Call __resetStore() in beforeEach to start each test with a clean table.
 */

type Row = Record<string, any>;

const store: Row[] = [];

export function __resetStore(): void {
  store.splice(0);
}

function rows(data: Row[]) {
  return {
    length: data.length,
    item: (i: number) => data[i] ?? null,
    raw: () => [...data],
  };
}

function result(data: Row[] = [], rowsAffected = 0, insertId = 0) {
  return { rows: rows(data), rowsAffected, insertId };
}

function executeSql(sql: string, params: any[] = []): Promise<[any]> {
  const n = sql.replace(/\s+/g, ' ').trim().toLowerCase();

  // ── CREATE TABLE ─────────────────────────────────────────────────────────
  if (n.startsWith('create table')) {
    return Promise.resolve([result()]);
  }

  // ── INSERT OR IGNORE ──────────────────────────────────────────────────────
  if (n.startsWith('insert or ignore')) {
    // Match both the column list and the VALUES tuple — some columns (e.g.
    // status, retry_count) are written as SQL literals rather than `?`
    // placeholders, so params can't just be zipped to cols by position.
    const match = sql.match(/\(\s*([\w\s,]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (!match) return Promise.resolve([result()]);
    const cols = match[1].split(',').map((c) => c.trim());
    const valueTokens = match[2].split(',').map((v) => v.trim());
    const pk = params[0];
    if (store.some((r) => r.local_asset_id === pk)) {
      return Promise.resolve([result([], 0)]);
    }
    const row: Row = {};
    let paramIndex = 0;
    cols.forEach((col, i) => {
      const token = valueTokens[i];
      if (token === '?') {
        row[col] = params[paramIndex] !== undefined ? params[paramIndex] : null;
        paramIndex++;
      } else if (/^'.*'$/.test(token)) {
        row[col] = token.slice(1, -1);
      } else {
        row[col] = Number(token);
      }
    });
    store.push(row);
    return Promise.resolve([result([], 1, store.length)]);
  }

  // ── UPDATE SET status = ? … WHERE local_asset_id = ? ─────────────────────
  if (n.startsWith('update upload_queue set status')) {
    const [status, uploadId, updatedAt, assetId] = params;
    let affected = 0;
    for (const row of store) {
      if (row.local_asset_id === assetId) {
        row.status = status;
        if (uploadId != null) row.upload_id = uploadId;
        row.updated_at = updatedAt;
        affected++;
      }
    }
    return Promise.resolve([result([], affected)]);
  }

  // ── UPDATE SET retry_count = retry_count + 1 ─────────────────────────────
  if (n.startsWith('update upload_queue set retry_count')) {
    const [updatedAt, assetId] = params;
    let affected = 0;
    for (const row of store) {
      if (row.local_asset_id === assetId) {
        row.retry_count = (row.retry_count ?? 0) + 1;
        row.status = 'failed';
        row.updated_at = updatedAt;
        affected++;
      }
    }
    return Promise.resolve([result([], affected)]);
  }

  // ── SELECT COUNT(*) ───────────────────────────────────────────────────────
  if (n.includes('select count(*)')) {
    const status = params[0];
    const count = store.filter((r) => r.status === status).length;
    return Promise.resolve([result([{ count }])]);
  }

  // ── SELECT status WHERE local_asset_id = ? ────────────────────────────────
  if (n.includes('select status from') && n.includes('local_asset_id')) {
    const row = store.find((r) => r.local_asset_id === params[0]);
    return Promise.resolve([result(row ? [{ status: row.status }] : [])]);
  }

  // ── SELECT * WHERE pending OR failed ─────────────────────────────────────
  if (n.includes("status = 'pending' or status = 'failed'")) {
    const limit = params.length > 0 ? Number(params[0]) : Infinity;
    const filtered = store
      .filter((r) => r.status === 'pending' || r.status === 'failed')
      .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))
      .slice(0, limit);
    return Promise.resolve([result(filtered)]);
  }

  // ── SELECT sha256_hash ────────────────────────────────────────────────────
  if (n.includes('select sha256_hash')) {
    const filtered = store.filter((r) => r.status === 'done' && r.sha256_hash != null);
    return Promise.resolve([result(filtered.map((r) => ({ sha256_hash: r.sha256_hash })))]);
  }

  // ── SELECT * WHERE status = 'done' ────────────────────────────────────────
  if (n.includes("status = 'done'")) {
    const filtered = store
      .filter((r) => r.status === 'done')
      .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    return Promise.resolve([result(filtered)]);
  }

  return Promise.resolve([result()]);
}

const fakeDB = { executeSql: jest.fn(executeSql) };

const SQLite = {
  enablePromise: jest.fn(),
  openDatabase: jest.fn(async () => fakeDB),
};

export default SQLite;
