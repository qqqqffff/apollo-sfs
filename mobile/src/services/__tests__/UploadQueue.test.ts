import {
  countByStatus,
  enqueue,
  getAllDoneItems,
  getDoneHashSet,
  getPendingItems,
  incrementRetry,
  isAlreadyDone,
  setStatus,
} from '../UploadQueue';
import { __resetStore } from '../../../__mocks__/react-native-sqlite-storage';

jest.mock('react-native-sqlite-storage');

beforeEach(() => {
  __resetStore();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeItem(id: string, overrides: Partial<{
  sha256_hash: string | null;
  size_bytes: number | null;
  mime_type: string | null;
}> = {}) {
  return {
    local_asset_id: id,
    local_uri: `ph://${id}`,
    filename: `photo-${id}.jpg`,
    sha256_hash: `hash-${id}`,
    size_bytes: 1024,
    mime_type: 'image/jpeg',
    ...overrides,
  };
}

// ── enqueue ───────────────────────────────────────────────────────────────────

describe('enqueue', () => {
  it('adds a new item as pending', async () => {
    await enqueue(makeItem('a'));
    const items = await getPendingItems(10);
    expect(items).toHaveLength(1);
    expect(items[0].local_asset_id).toBe('a');
    expect(items[0].status).toBe('pending');
  });

  it('is idempotent — duplicate asset ID is ignored', async () => {
    await enqueue(makeItem('a'));
    await enqueue(makeItem('a'));
    const items = await getPendingItems(10);
    expect(items).toHaveLength(1);
  });

  it('stores all provided fields', async () => {
    await enqueue(makeItem('b', { sha256_hash: 'abc', size_bytes: 4096, mime_type: 'image/png' }));
    const items = await getPendingItems(10);
    const item = items[0];
    expect(item.sha256_hash).toBe('abc');
    expect(item.size_bytes).toBe(4096);
    expect(item.mime_type).toBe('image/png');
    expect(item.filename).toBe('photo-b.jpg');
  });

  it('handles null optional fields', async () => {
    await enqueue(makeItem('c', { sha256_hash: null, size_bytes: null, mime_type: null }));
    const items = await getPendingItems(10);
    expect(items[0].sha256_hash).toBeNull();
    expect(items[0].size_bytes).toBeNull();
    expect(items[0].mime_type).toBeNull();
  });
});

// ── getPendingItems ────────────────────────────────────────────────────────────

describe('getPendingItems', () => {
  it('returns only pending and failed items', async () => {
    await enqueue(makeItem('a'));
    await enqueue(makeItem('b'));
    await enqueue(makeItem('c'));
    await setStatus('b', 'done');

    const items = await getPendingItems(10);
    expect(items.map((i) => i.local_asset_id)).toEqual(['a', 'c']);
  });

  it('includes failed items alongside pending', async () => {
    await enqueue(makeItem('a'));
    await enqueue(makeItem('b'));
    await setStatus('a', 'failed');

    const items = await getPendingItems(10);
    expect(items).toHaveLength(2);
  });

  it('respects the limit parameter', async () => {
    await enqueue(makeItem('a'));
    await enqueue(makeItem('b'));
    await enqueue(makeItem('c'));

    const items = await getPendingItems(2);
    expect(items).toHaveLength(2);
  });

  it('returns items ordered by created_at ascending', async () => {
    // Items are created slightly apart in time
    await enqueue(makeItem('first'));
    await new Promise((r) => setTimeout(r, 2));
    await enqueue(makeItem('second'));

    const items = await getPendingItems(10);
    expect(items[0].local_asset_id).toBe('first');
    expect(items[1].local_asset_id).toBe('second');
  });

  it('returns empty array when no pending items exist', async () => {
    const items = await getPendingItems(10);
    expect(items).toHaveLength(0);
  });
});

// ── setStatus ─────────────────────────────────────────────────────────────────

describe('setStatus', () => {
  it('changes item status', async () => {
    await enqueue(makeItem('a'));
    await setStatus('a', 'done');
    const count = await countByStatus('done');
    expect(count).toBe(1);
  });

  it('stores optional upload_id', async () => {
    await enqueue(makeItem('a'));
    await setStatus('a', 'uploading', 'upload-xyz');
    const items = await getPendingItems(10);
    // uploading status is not in getPendingItems
    expect(items).toHaveLength(0);
  });

  it('does not affect unrelated items', async () => {
    await enqueue(makeItem('a'));
    await enqueue(makeItem('b'));
    await setStatus('a', 'done');

    expect(await countByStatus('done')).toBe(1);
    expect(await countByStatus('pending')).toBe(1);
  });
});

// ── isAlreadyDone ─────────────────────────────────────────────────────────────

describe('isAlreadyDone', () => {
  it('returns false for unknown asset IDs', async () => {
    expect(await isAlreadyDone('unknown')).toBe(false);
  });

  it('returns false for pending items', async () => {
    await enqueue(makeItem('a'));
    expect(await isAlreadyDone('a')).toBe(false);
  });

  it('returns true after setStatus done', async () => {
    await enqueue(makeItem('a'));
    await setStatus('a', 'done');
    expect(await isAlreadyDone('a')).toBe(true);
  });
});

// ── countByStatus ─────────────────────────────────────────────────────────────

describe('countByStatus', () => {
  it('returns 0 for empty queue', async () => {
    expect(await countByStatus('pending')).toBe(0);
    expect(await countByStatus('done')).toBe(0);
    expect(await countByStatus('failed')).toBe(0);
  });

  it('counts items correctly across statuses', async () => {
    await enqueue(makeItem('a'));
    await enqueue(makeItem('b'));
    await enqueue(makeItem('c'));
    await setStatus('b', 'done');
    await setStatus('c', 'failed');

    expect(await countByStatus('pending')).toBe(1);
    expect(await countByStatus('done')).toBe(1);
    expect(await countByStatus('failed')).toBe(1);
  });
});

// ── incrementRetry ────────────────────────────────────────────────────────────

describe('incrementRetry', () => {
  it('increments retry count and sets status to failed', async () => {
    await enqueue(makeItem('a'));
    await setStatus('a', 'uploading');
    await incrementRetry('a');

    const items = await getPendingItems(10);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('failed');
    expect(items[0].retry_count).toBe(1);
  });

  it('accumulates retries across multiple calls', async () => {
    await enqueue(makeItem('a'));
    await incrementRetry('a');
    await incrementRetry('a');
    await incrementRetry('a');

    const items = await getPendingItems(10);
    expect(items[0].retry_count).toBe(3);
  });
});

// ── getAllDoneItems ────────────────────────────────────────────────────────────

describe('getAllDoneItems', () => {
  it('returns only done items', async () => {
    await enqueue(makeItem('a'));
    await enqueue(makeItem('b'));
    await enqueue(makeItem('c'));
    await setStatus('a', 'done');
    await setStatus('c', 'done');

    const done = await getAllDoneItems();
    expect(done.map((i) => i.local_asset_id).sort()).toEqual(['a', 'c']);
  });

  it('returns empty array when nothing is done', async () => {
    await enqueue(makeItem('a'));
    expect(await getAllDoneItems()).toHaveLength(0);
  });
});

// ── getDoneHashSet ─────────────────────────────────────────────────────────────

describe('getDoneHashSet', () => {
  it('returns set of sha256 hashes for done items', async () => {
    await enqueue(makeItem('a', { sha256_hash: 'hash-aaa' }));
    await enqueue(makeItem('b', { sha256_hash: 'hash-bbb' }));
    await enqueue(makeItem('c', { sha256_hash: 'hash-ccc' }));
    await setStatus('a', 'done');
    await setStatus('b', 'done');
    // c stays pending

    const set = await getDoneHashSet();
    expect(set.has('hash-aaa')).toBe(true);
    expect(set.has('hash-bbb')).toBe(true);
    expect(set.has('hash-ccc')).toBe(false);
  });

  it('excludes null hashes', async () => {
    await enqueue(makeItem('a', { sha256_hash: null }));
    await setStatus('a', 'done');

    const set = await getDoneHashSet();
    expect(set.size).toBe(0);
  });
});
