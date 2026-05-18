import { renderHook, act } from '@testing-library/react'
import { useFileUpload } from '../../hooks/useFileUpload'

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('../../api/files', () => ({
  CHUNK_SIZE: 5 * 1024 * 1024,
  uploadFile:            jest.fn(),
  initChunkedUpload:     jest.fn(),
  uploadChunk:           jest.fn(),
  completeChunkedUpload: jest.fn(),
}))

import { uploadFile, initChunkedUpload, uploadChunk, completeChunkedUpload } from '../../api/files'

const mockUploadFile            = uploadFile            as jest.Mock
const mockInitChunkedUpload     = initChunkedUpload     as jest.Mock
const mockUploadChunk           = uploadChunk           as jest.Mock
const mockCompleteChunkedUpload = completeChunkedUpload as jest.Mock

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFile(name: string, size: number): File {
  const f = new File([new ArrayBuffer(Math.min(size, 1))], name)
  Object.defineProperty(f, 'size', { value: size })
  return f
}

const SMALL_FILE = makeFile('small.txt', 100)
const CHUNK_SIZE = 5 * 1024 * 1024
const LARGE_FILE = makeFile('large.bin', CHUNK_SIZE + 1)

beforeEach(() => {
  mockUploadFile.mockReset()
  mockInitChunkedUpload.mockReset()
  mockUploadChunk.mockReset()
  mockCompleteChunkedUpload.mockReset()
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
    mockUploadFile.mockImplementation(() => new Promise(() => {})) // never resolves
    const { result } = renderHook(() => useFileUpload())
    act(() => { result.current.startUpload([SMALL_FILE], null, jest.fn()) })
    expect(result.current.progress.status).toBe('uploading')
  })

  it('initialises one item per file', () => {
    mockUploadFile.mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => useFileUpload())
    act(() => { result.current.startUpload([SMALL_FILE], null, jest.fn()) })
    expect(result.current.progress.items).toHaveLength(1)
    expect(result.current.progress.items[0].name).toBe('small.txt')
  })

  it('sets status=complete after all files succeed', async () => {
    mockUploadFile.mockResolvedValue({ file: { id: 'f1' } })
    const { result } = renderHook(() => useFileUpload())
    await act(async () => {
      await result.current.startUpload([SMALL_FILE], null, jest.fn())
    })
    expect(result.current.progress.status).toBe('complete')
    expect(result.current.progress.succeeded).toBe(1)
    expect(result.current.progress.failed).toBe(0)
  })

  it('calls onAnySuccess when at least one file succeeds', async () => {
    mockUploadFile.mockResolvedValue({ file: { id: 'f1' } })
    const onAnySuccess = jest.fn()
    const { result } = renderHook(() => useFileUpload())
    await act(async () => {
      await result.current.startUpload([SMALL_FILE], null, onAnySuccess)
    })
    expect(onAnySuccess).toHaveBeenCalledTimes(1)
  })

  it('sets totalBytes to the sum of all file sizes', () => {
    mockUploadFile.mockImplementation(() => new Promise(() => {}))
    const a = makeFile('a.txt', 200)
    const b = makeFile('b.txt', 300)
    const { result } = renderHook(() => useFileUpload())
    act(() => { result.current.startUpload([a, b], null, jest.fn()) })
    expect(result.current.progress.totalBytes).toBe(500)
  })

  it('passes folderId to uploadFile', async () => {
    mockUploadFile.mockResolvedValue({ file: { id: 'f1' } })
    const { result } = renderHook(() => useFileUpload())
    await act(async () => {
      await result.current.startUpload([SMALL_FILE], 'folder-xyz', jest.fn())
    })
    expect(mockUploadFile).toHaveBeenCalledWith('folder-xyz', SMALL_FILE, expect.any(Function))
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
    mockUploadFile.mockRejectedValue(new Error('network error'))
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
    mockUploadFile
      .mockResolvedValueOnce({ file: { id: 'f1' } }) // good — resolves immediately
      .mockRejectedValue(new Error('fail'))            // bad — all retries fail
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
    mockUploadFile.mockRejectedValue(new Error('fail'))
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
  it('uses initChunkedUpload for files larger than CHUNK_SIZE', async () => {
    mockInitChunkedUpload.mockResolvedValue({ upload_id: 'up-1' })
    mockUploadChunk.mockResolvedValue({ chunk_index: 0, dispatched: 1, total: 1 })
    mockCompleteChunkedUpload.mockResolvedValue({ file: { id: 'f1' } })
    const { result } = renderHook(() => useFileUpload())
    await act(async () => {
      await result.current.startUpload([LARGE_FILE], null, jest.fn())
    })
    expect(mockInitChunkedUpload).toHaveBeenCalledWith(
      LARGE_FILE.name,
      2, // ceil((CHUNK_SIZE+1) / CHUNK_SIZE) = 2
      LARGE_FILE.size,
      null,
    )
    expect(mockUploadChunk).toHaveBeenCalled()
    expect(mockCompleteChunkedUpload).toHaveBeenCalledWith('up-1')
  })
})

describe('useFileUpload — dismiss', () => {
  it('resets progress back to idle', async () => {
    mockUploadFile.mockResolvedValue({ file: { id: 'f1' } })
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
