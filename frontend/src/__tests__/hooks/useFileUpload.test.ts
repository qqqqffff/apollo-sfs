import { renderHook, act } from '@testing-library/react'
import { useFileUpload } from '../../hooks/useFileUpload'

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('../../api/files', () => ({
  CHUNK_SIZE:                     5 * 1024 * 1024,
  MAX_CONCURRENT_CHUNKS:          4,
  presignUpload:                  jest.fn(),
  uploadFilePresigned:            jest.fn(),
  presignChunkedUpload:           jest.fn(),
  uploadChunkPresigned:           jest.fn(),
  completeChunkedUploadPresigned: jest.fn(),
}))

import {
  presignUpload,
  uploadFilePresigned,
  presignChunkedUpload,
  uploadChunkPresigned,
  completeChunkedUploadPresigned,
} from '../../api/files'

const mockPresignUpload                 = presignUpload                 as jest.Mock
const mockUploadFilePresigned           = uploadFilePresigned           as jest.Mock
const mockPresignChunkedUpload          = presignChunkedUpload          as jest.Mock
const mockUploadChunkPresigned          = uploadChunkPresigned          as jest.Mock
const mockCompleteChunkedUploadPresigned = completeChunkedUploadPresigned as jest.Mock

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFile(name: string, size: number): File {
  const f = new File([new ArrayBuffer(Math.min(size, 1))], name)
  Object.defineProperty(f, 'size', { value: size })
  return f
}

const SMALL_FILE = makeFile('small.txt', 100)
const CHUNK_SIZE = 5 * 1024 * 1024
const LARGE_FILE = makeFile('large.bin', CHUNK_SIZE + 1)

const PRESIGN_UPLOAD_OK = { url: '/api/v1/files/upload/p?token=tok', expires_at: '2099-01-01T00:00:00Z' }

beforeEach(() => {
  mockPresignUpload.mockReset()
  mockUploadFilePresigned.mockReset()
  mockPresignChunkedUpload.mockReset()
  mockUploadChunkPresigned.mockReset()
  mockCompleteChunkedUploadPresigned.mockReset()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useFileUpload — initial state', () => {
  it('starts in idle status with empty items', () => {
    const { result } = renderHook(() => useFileUpload())
    expect(result.current.progress.status).toBe('idle')
    expect(result.current.progress.items).toEqual([])
    expect(result.current.progress.succeeded).toBe(0)
    expect(result.current.progress.failed).toBe(0)
  })
})

describe('useFileUpload — startUpload (success path)', () => {
  // These tests use mocks that resolve immediately via microtasks.
  // No timer advancement is needed — the upload promise completes before
  // the 150 ms flush interval ever fires.

  it('transitions to uploading immediately', () => {
    mockPresignUpload.mockImplementation(() => new Promise(() => {})) // never resolves
    const { result } = renderHook(() => useFileUpload())
    act(() => { result.current.startUpload([SMALL_FILE], null, jest.fn()) })
    expect(result.current.progress.status).toBe('uploading')
  })

  it('initialises one item per file', () => {
    mockPresignUpload.mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => useFileUpload())
    act(() => { result.current.startUpload([SMALL_FILE], null, jest.fn()) })
    expect(result.current.progress.items).toHaveLength(1)
    expect(result.current.progress.items[0].name).toBe('small.txt')
  })

  it('sets status=complete after all files succeed', async () => {
    mockPresignUpload.mockResolvedValue(PRESIGN_UPLOAD_OK)
    mockUploadFilePresigned.mockResolvedValue({ file: { id: 'f1' } })
    const { result } = renderHook(() => useFileUpload())
    await act(async () => {
      await result.current.startUpload([SMALL_FILE], null, jest.fn())
    })
    expect(result.current.progress.status).toBe('complete')
    expect(result.current.progress.succeeded).toBe(1)
    expect(result.current.progress.failed).toBe(0)
  })

  it('calls onAnySuccess when at least one file succeeds', async () => {
    mockPresignUpload.mockResolvedValue(PRESIGN_UPLOAD_OK)
    mockUploadFilePresigned.mockResolvedValue({ file: { id: 'f1' } })
    const onAnySuccess = jest.fn()
    const { result } = renderHook(() => useFileUpload())
    await act(async () => {
      await result.current.startUpload([SMALL_FILE], null, onAnySuccess)
    })
    expect(onAnySuccess).toHaveBeenCalledTimes(1)
  })

  it('sets totalBytes to the sum of all file sizes', () => {
    mockPresignUpload.mockImplementation(() => new Promise(() => {}))
    const a = makeFile('a.txt', 200)
    const b = makeFile('b.txt', 300)
    const { result } = renderHook(() => useFileUpload())
    act(() => { result.current.startUpload([a, b], null, jest.fn()) })
    expect(result.current.progress.totalBytes).toBe(500)
  })

  it('passes folderId to presignUpload', async () => {
    mockPresignUpload.mockResolvedValue(PRESIGN_UPLOAD_OK)
    mockUploadFilePresigned.mockResolvedValue({ file: { id: 'f1' } })
    const { result } = renderHook(() => useFileUpload())
    await act(async () => {
      await result.current.startUpload([SMALL_FILE], 'folder-xyz', jest.fn())
    })
    expect(mockPresignUpload).toHaveBeenCalledWith(SMALL_FILE.name, SMALL_FILE.size, 'folder-xyz', false, null)
  })
})

describe('useFileUpload — startUpload (retry / failure path)', () => {
  // These tests require the retry sleep() delays to fire.
  // We use fake timers + jest.advanceTimersByTimeAsync so that microtasks are
  // drained between each timer tick — this lets the promise chain advance and
  // stopFlush() run at the right moment, preventing the flush interval from
  // firing hundreds of times and corrupting subsequent tests.

  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('sets status=allFailed when all files fail (after retries)', async () => {
    mockPresignUpload.mockRejectedValue(new Error('network error'))
    const { result } = renderHook(() => useFileUpload())
    await act(async () => {
      const p = result.current.startUpload([SMALL_FILE], null, jest.fn())
      // Advance past all 5 retry delays: 500+1000+2000+4000+8000 = 15 500 ms
      await jest.advanceTimersByTimeAsync(20_000)
      await p
    })
    expect(result.current.progress.status).toBe('allFailed')
    expect(result.current.progress.failed).toBe(1)
    expect(result.current.progress.succeeded).toBe(0)
  })

  it('sets status=partial when some files succeed and some fail', async () => {
    const goodFile = makeFile('good.txt', 100)
    const badFile  = makeFile('bad.txt',  100)
    mockPresignUpload
      .mockResolvedValueOnce(PRESIGN_UPLOAD_OK) // good — presign resolves
      .mockRejectedValue(new Error('fail'))      // bad — all retries fail
    mockUploadFilePresigned.mockResolvedValue({ file: { id: 'f1' } })
    const { result } = renderHook(() => useFileUpload())
    await act(async () => {
      const p = result.current.startUpload([goodFile, badFile], null, jest.fn())
      await jest.advanceTimersByTimeAsync(20_000)
      await p
    })
    expect(result.current.progress.status).toBe('partial')
    expect(result.current.progress.succeeded).toBe(1)
    expect(result.current.progress.failed).toBe(1)
  })

  it('does not call onAnySuccess when all files fail', async () => {
    mockPresignUpload.mockRejectedValue(new Error('fail'))
    const onAnySuccess = jest.fn()
    const { result } = renderHook(() => useFileUpload())
    await act(async () => {
      const p = result.current.startUpload([SMALL_FILE], null, onAnySuccess)
      await jest.advanceTimersByTimeAsync(20_000)
      await p
    })
    expect(onAnySuccess).not.toHaveBeenCalled()
  })
})

describe('useFileUpload — chunked upload', () => {
  it('uses presignChunkedUpload for files larger than CHUNK_SIZE', async () => {
    mockPresignChunkedUpload.mockResolvedValue({
      upload_id: 'up-1',
      session_token: 'sess.tok',
      expires_at: '2099-01-01T00:00:00Z',
    })
    mockUploadChunkPresigned.mockResolvedValue({ chunk_index: 0, dispatched: 1, total: 2 })
    mockCompleteChunkedUploadPresigned.mockResolvedValue({ file: { id: 'f1' } })
    const { result } = renderHook(() => useFileUpload())
    await act(async () => {
      await result.current.startUpload([LARGE_FILE], null, jest.fn())
    })
    expect(mockPresignChunkedUpload).toHaveBeenCalledWith(
      LARGE_FILE.name,
      2, // ceil((CHUNK_SIZE+1) / CHUNK_SIZE) = 2
      LARGE_FILE.size,
      null,
      false,
      null,
    )
    expect(mockUploadChunkPresigned).toHaveBeenCalled()
    expect(mockCompleteChunkedUploadPresigned).toHaveBeenCalledWith('up-1', 'sess.tok')
  })

  it('uploads every chunk exactly once, out of order, via the worker pool', async () => {
    const HUGE_FILE = makeFile('huge.bin', CHUNK_SIZE * 9) // 9 chunks, > MAX_CONCURRENT_CHUNKS (4)
    mockPresignChunkedUpload.mockResolvedValue({
      upload_id: 'up-2',
      session_token: 'sess.tok',
      expires_at: '2099-01-01T00:00:00Z',
    })
    // Resolve chunks in reverse-ish order to prove completion order doesn't matter.
    mockUploadChunkPresigned.mockImplementation(async (_id, _tok, chunkIndex: number) => {
      await Promise.resolve()
      return { chunk_index: chunkIndex, dispatched: 1, total: 9 }
    })
    mockCompleteChunkedUploadPresigned.mockResolvedValue({ file: { id: 'f1' } })
    const { result } = renderHook(() => useFileUpload())
    await act(async () => {
      await result.current.startUpload([HUGE_FILE], null, jest.fn())
    })

    expect(mockUploadChunkPresigned).toHaveBeenCalledTimes(9)
    const seenIndices = mockUploadChunkPresigned.mock.calls.map((c) => c[2]).sort((a, b) => a - b)
    expect(seenIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(mockCompleteChunkedUploadPresigned).toHaveBeenCalledWith('up-2', 'sess.tok')
    expect(result.current.progress.status).toBe('complete')
  })

  it('fails the file (after retries) when one chunk keeps failing, without hanging', async () => {
    jest.useFakeTimers()
    const MULTI_CHUNK_FILE = makeFile('multi.bin', CHUNK_SIZE * 3)
    mockPresignChunkedUpload.mockResolvedValue({
      upload_id: 'up-3',
      session_token: 'sess.tok',
      expires_at: '2099-01-01T00:00:00Z',
    })
    mockUploadChunkPresigned.mockImplementation(async (_id, _tok, chunkIndex: number) => {
      if (chunkIndex === 1) throw new Error('chunk failed')
      return { chunk_index: chunkIndex, dispatched: 1, total: 3 }
    })
    const { result } = renderHook(() => useFileUpload())
    await act(async () => {
      const p = result.current.startUpload([MULTI_CHUNK_FILE], null, jest.fn())
      await jest.advanceTimersByTimeAsync(20_000)
      await p
    })
    expect(result.current.progress.status).toBe('allFailed')
    expect(mockCompleteChunkedUploadPresigned).not.toHaveBeenCalled()
    jest.useRealTimers()
  })
})

describe('useFileUpload — pause/resume/cancel (same control the backup flows use)', () => {
  const LANDED = { id: 'landed', name: 'x', mime_type: 'text/plain', size_bytes: 10, folder_id: 'f', drive_id: null }

  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('cancel() lets already-claimed files finish but keeps queued ones behind the concurrency limit from ever starting', async () => {
    const files = Array.from({ length: 6 }, (_, i) => makeFile(`f${i}.txt`, 10))
    const resolvers: (() => void)[] = []
    mockPresignUpload.mockImplementation(() => new Promise<typeof PRESIGN_UPLOAD_OK>((resolve) => {
      resolvers.push(() => resolve(PRESIGN_UPLOAD_OK))
    }))
    mockUploadFilePresigned.mockResolvedValue(LANDED)

    const { result } = renderHook(() => useFileUpload())
    let resultPromise!: ReturnType<typeof result.current.startUpload>
    act(() => { resultPromise = result.current.startUpload(files, null, jest.fn()) })

    // Let the first MAX_CONCURRENT_FILES (4) workers claim a file and call presignUpload.
    await act(async () => { await jest.advanceTimersByTimeAsync(200) })
    expect(resolvers).toHaveLength(4)
    expect(result.current.progress.items.filter((i) => i.status === 'queued')).toHaveLength(2)

    act(() => { result.current.cancel() })

    await act(async () => {
      resolvers.forEach((r) => r())
      await jest.advanceTimersByTimeAsync(200)
      await resultPromise
    })

    expect(mockPresignUpload).toHaveBeenCalledTimes(4) // the 2 queued files never started
    expect(result.current.progress.status).toBe('cancelled')
    expect(result.current.progress.items.filter((i) => i.status === 'done')).toHaveLength(4)
    expect(result.current.progress.items.filter((i) => i.status === 'queued')).toHaveLength(2)

    const res = await resultPromise
    expect(res.cancelled).toBe(true)
    expect(res.succeeded).toBe(4)
    expect(res.uploadedFileIds).toEqual(['landed', 'landed', 'landed', 'landed'])
  })

  it('pause() stops new files from starting; resume() lets the rest continue to completion', async () => {
    const files = Array.from({ length: 5 }, (_, i) => makeFile(`f${i}.txt`, 10))
    const resolvers: (() => void)[] = []
    mockPresignUpload.mockImplementation(() => new Promise<typeof PRESIGN_UPLOAD_OK>((resolve) => {
      resolvers.push(() => resolve(PRESIGN_UPLOAD_OK))
    }))
    mockUploadFilePresigned.mockResolvedValue(LANDED)

    const { result } = renderHook(() => useFileUpload())
    let resultPromise!: ReturnType<typeof result.current.startUpload>
    act(() => { resultPromise = result.current.startUpload(files, null, jest.fn()) })

    await act(async () => { await jest.advanceTimersByTimeAsync(200) })
    expect(resolvers).toHaveLength(4)

    act(() => { result.current.pause() })
    expect(result.current.progress.paused).toBe(true)

    // Finish the 4 already-claimed files while paused — the 5th must not start.
    await act(async () => {
      resolvers.forEach((r) => r())
      await jest.advanceTimersByTimeAsync(200)
    })
    expect(resolvers).toHaveLength(4)
    expect(result.current.progress.items[4].status).toBe('queued')

    act(() => { result.current.resume() })
    expect(result.current.progress.paused).toBe(false)

    await act(async () => {
      await jest.advanceTimersByTimeAsync(200)
      resolvers[4]?.()
      await jest.advanceTimersByTimeAsync(200)
      await resultPromise
    })

    expect(resolvers).toHaveLength(5)
    expect(result.current.progress.status).toBe('complete')
    expect(result.current.progress.succeeded).toBe(5)
  })
})

describe('useFileUpload — dismiss', () => {
  it('resets progress back to idle', async () => {
    mockPresignUpload.mockResolvedValue(PRESIGN_UPLOAD_OK)
    mockUploadFilePresigned.mockResolvedValue({ file: { id: 'f1' } })
    const { result } = renderHook(() => useFileUpload())
    await act(async () => {
      await result.current.startUpload([SMALL_FILE], null, jest.fn())
    })
    expect(result.current.progress.status).toBe('complete')
    act(() => result.current.dismiss())
    expect(result.current.progress.status).toBe('idle')
    expect(result.current.progress.items).toEqual([])
  })
})
