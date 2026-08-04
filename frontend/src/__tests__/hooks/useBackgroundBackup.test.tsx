import React from 'react'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useBackgroundBackup } from '../../hooks/useBackgroundBackup'
import type { BackupProgressEvent, BackupRunResult } from '../../api/backupControl'

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

interface Entry { id: string }

function ok(overrides: Partial<BackupRunResult> = {}): BackupRunResult {
  return { uploaded: 1, duplicates: 0, errors: 0, cancelled: false, uploadedFileIds: [], ...overrides }
}

describe('useBackgroundBackup — progress, rate, and per-item stage', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(0)
  })
  afterEach(() => jest.useRealTimers())

  test('storedBytes tracks completed items and speedBps stays 0 until a second sample exists', async () => {
    const { result } = renderHook(() => useBackgroundBackup(), { wrapper: makeWrapper() })

    let onProgress!: (e: BackupProgressEvent<Entry>) => void
    let resolveRun!: (r: BackupRunResult) => void
    const runPromise = new Promise<BackupRunResult>((resolve) => { resolveRun = resolve })

    act(() => {
      result.current.start({
        total: 2, totalBytes: 2000, unit: 'file',
        run: async (opts) => { onProgress = opts.onProgress as typeof onProgress; return runPromise },
      })
    })

    act(() => {
      onProgress({ phase: 'settled', entry: { id: 'a' }, index: 0, done: 1, total: 2, path: 'a.txt', status: 'done', sizeBytes: 1000 })
    })
    // A single sample isn't enough to estimate a rate yet.
    expect(result.current.state?.storedBytes).toBe(1000)
    expect(result.current.state?.speedBps).toBe(0)

    jest.setSystemTime(1000)
    act(() => {
      onProgress({ phase: 'settled', entry: { id: 'b' }, index: 1, done: 2, total: 2, path: 'b.txt', status: 'done', sizeBytes: 1000 })
    })
    expect(result.current.state?.storedBytes).toBe(2000)
    expect(result.current.state?.speedBps).toBeCloseTo(1000)

    await act(async () => { resolveRun(ok({ uploaded: 2 })) })
    expect(result.current.state?.running).toBe(false)
  })

  test('itemStage/itemLoadedBytes/itemTotalBytes populate on a progress event and clear once the item settles', async () => {
    const { result } = renderHook(() => useBackgroundBackup(), { wrapper: makeWrapper() })

    let onProgress!: (e: BackupProgressEvent<Entry>) => void
    const runPromise = new Promise<BackupRunResult>(() => {}) // never settles — this test only cares about in-flight state

    act(() => {
      result.current.start({
        total: 1, totalBytes: 6_000_000, unit: 'file',
        run: async (opts) => { onProgress = opts.onProgress as typeof onProgress; return runPromise },
      })
    })

    act(() => {
      onProgress({
        phase: 'progress', entry: { id: 'a' }, index: 0, done: 0, total: 1, path: 'video.mp4',
        stage: 'downloading', loadedBytes: 2_000_000, itemTotalBytes: 6_000_000,
      })
    })
    expect(result.current.state?.itemStage).toBe('downloading')
    expect(result.current.state?.itemLoadedBytes).toBe(2_000_000)
    expect(result.current.state?.itemTotalBytes).toBe(6_000_000)
    // In-flight bytes count toward the live rate estimate even before the
    // item settles — otherwise a single huge file would show no progress
    // until it's fully done, the exact bug this exists to fix.
    expect(result.current.state?.storedBytes).toBe(0)

    act(() => {
      onProgress({
        phase: 'settled', entry: { id: 'a' }, index: 0, done: 1, total: 1, path: 'video.mp4',
        status: 'done', sizeBytes: 6_000_000,
      })
    })
    expect(result.current.state?.itemStage).toBeUndefined()
    expect(result.current.state?.storedBytes).toBe(6_000_000)
  })

  test('a fresh run resets storedBytes and speedBps rather than carrying over the previous run', async () => {
    const { result } = renderHook(() => useBackgroundBackup(), { wrapper: makeWrapper() })

    let onProgress!: (e: BackupProgressEvent<Entry>) => void
    let resolveRun!: (r: BackupRunResult) => void
    let runPromise = new Promise<BackupRunResult>((resolve) => { resolveRun = resolve })

    act(() => {
      result.current.start({
        total: 1, totalBytes: 1000, unit: 'file',
        run: async (opts) => { onProgress = opts.onProgress as typeof onProgress; return runPromise },
      })
    })
    act(() => onProgress({ phase: 'settled', entry: { id: 'a' }, index: 0, done: 1, total: 1, path: 'a.txt', status: 'done', sizeBytes: 1000 }))
    await act(async () => resolveRun(ok()))
    expect(result.current.state?.storedBytes).toBe(1000)

    runPromise = new Promise<BackupRunResult>((resolve) => { resolveRun = resolve })
    act(() => {
      result.current.start({
        total: 1, totalBytes: 500, unit: 'file',
        run: async (opts) => { onProgress = opts.onProgress as typeof onProgress; return runPromise },
      })
    })
    expect(result.current.state?.storedBytes).toBe(0)
    expect(result.current.state?.speedBps).toBe(0)
    await act(async () => resolveRun(ok()))
  })
})
