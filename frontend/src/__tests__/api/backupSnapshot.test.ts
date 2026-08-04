import { makeBackupSnapshotStore, type BackupSnapshot } from '../../api/backupSnapshot'

interface Entry { id: string }

function snapshot(overrides: Partial<BackupSnapshot<Entry, null>> = {}): BackupSnapshot<Entry, null> {
  return {
    entries: [{ id: 'a' }, { id: 'b' }],
    doneCount: 0,
    totalBytes: 100,
    uploaded: 0,
    duplicates: 0,
    errors: 0,
    storedCount: 0,
    storedBytes: 0,
    savedAt: '2026-01-01T00:00:00.000Z',
    context: null,
    ...overrides,
  }
}

describe('makeBackupSnapshotStore', () => {
  beforeEach(() => {
    localStorage.clear()
    jest.useFakeTimers()
  })
  afterEach(() => jest.useRealTimers())

  test('load returns null when nothing has been saved', () => {
    const store = makeBackupSnapshotStore<Entry, null>('test-key-1')
    expect(store.load()).toBeNull()
  })

  test('saveNow writes immediately, bypassing the throttle', () => {
    const store = makeBackupSnapshotStore<Entry, null>('test-key-2')
    store.saveNow(snapshot({ doneCount: 1 }))
    expect(store.load()).toMatchObject({ doneCount: 1 })
  })

  test('save throttles: an immediate second save within the window is not written until the timer fires', () => {
    const store = makeBackupSnapshotStore<Entry, null>('test-key-3')
    store.saveNow(snapshot({ doneCount: 0 })) // resets the throttle window
    store.save(snapshot({ doneCount: 1 }))
    // Still the old value — the throttled write hasn't flushed yet.
    expect(store.load()).toMatchObject({ doneCount: 0 })

    jest.advanceTimersByTime(1000)
    expect(store.load()).toMatchObject({ doneCount: 1 })
  })

  test('save collapses rapid updates into the latest value once the throttle fires', () => {
    const store = makeBackupSnapshotStore<Entry, null>('test-key-4')
    store.saveNow(snapshot({ doneCount: 0 }))
    store.save(snapshot({ doneCount: 1 }))
    store.save(snapshot({ doneCount: 2 }))
    store.save(snapshot({ doneCount: 3 }))

    jest.advanceTimersByTime(1000)
    expect(store.load()).toMatchObject({ doneCount: 3 })
  })

  test('clear removes the snapshot and cancels a pending throttled write', () => {
    const store = makeBackupSnapshotStore<Entry, null>('test-key-5')
    store.saveNow(snapshot({ doneCount: 0 }))
    store.save(snapshot({ doneCount: 1 }))
    store.clear()

    jest.advanceTimersByTime(2000)
    expect(store.load()).toBeNull()
  })

  test('stores are isolated by key', () => {
    const storeA = makeBackupSnapshotStore<Entry, null>('test-key-a')
    const storeB = makeBackupSnapshotStore<Entry, null>('test-key-b')
    storeA.saveNow(snapshot({ doneCount: 5 }))
    expect(storeB.load()).toBeNull()
    expect(storeA.load()).toMatchObject({ doneCount: 5 })
  })

  test('round-trips a non-null context', () => {
    interface Ctx { provider: 'gmail' | 'microsoft'; folderId: string }
    const store = makeBackupSnapshotStore<Entry, Ctx>('test-key-ctx')
    store.saveNow({
      entries: [{ id: 'a' }], doneCount: 0, totalBytes: 10,
      uploaded: 0, duplicates: 0, errors: 0, storedCount: 0, storedBytes: 0,
      savedAt: '2026-01-01T00:00:00.000Z', context: { provider: 'gmail', folderId: 'f1' },
    })
    expect(store.load()?.context).toEqual({ provider: 'gmail', folderId: 'f1' })
  })
})
