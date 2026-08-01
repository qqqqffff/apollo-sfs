import { renderHook, act } from '@testing-library/react'
import { useDeleteJob } from '../../hooks/useDeleteJob'

jest.mock('../../api/files', () => ({
  deleteFile: jest.fn(),
}))

jest.mock('../../api/folders', () => ({
  deleteFolder: jest.fn(),
  getFolder: jest.fn(),
}))

import { deleteFile } from '../../api/files'
import { deleteFolder, getFolder } from '../../api/folders'

const mockDeleteFile = deleteFile as jest.Mock
const mockDeleteFolder = deleteFolder as jest.Mock
const mockGetFolder = getFolder as jest.Mock

function page(
  files: { id: string; name: string; size_bytes: number }[],
  subfolders: { id: string }[] = [],
  nextToken = '',
) {
  return {
    folder: null,
    subfolders: { items: subfolders, next_token: '' },
    files: { items: files, next_token: nextToken },
  }
}

function makeFiles(prefix: string, count: number, sizeEach = 1) {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix}${i}.txt`, size_bytes: sizeEach }))
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDeleteFile.mockResolvedValue({ message: 'deleted' })
  mockDeleteFolder.mockResolvedValue({ message: 'deleted' })
})

describe('useDeleteJob', () => {
  test('deletes a single file target', async () => {
    const { result } = renderHook(() => useDeleteJob())

    await act(async () => {
      await result.current.startDelete([{ type: 'file', id: 'f1', name: 'a.txt', sizeBytes: 10 }])
    })

    expect(mockDeleteFile).toHaveBeenCalledWith('f1')
    expect(mockDeleteFolder).not.toHaveBeenCalled()
    expect(result.current.progress.status).toBe('complete')
    expect(result.current.progress.succeeded).toBe(1)
    expect(result.current.progress.items[0]).toMatchObject({ status: 'done', loaded: 10 })
  })

  test('empties a non-empty folder subtree before deleting the folders themselves, in post-order', async () => {
    // root folder "parent" has one file + one subfolder "child"; "child" has one file only.
    mockGetFolder.mockImplementation((folderId: string) => {
      if (folderId === 'parent') {
        return Promise.resolve(page([{ id: 'file-root', name: 'root.txt', size_bytes: 5 }], [{ id: 'child' }]))
      }
      if (folderId === 'child') {
        return Promise.resolve(page([{ id: 'file-child', name: 'child.txt', size_bytes: 7 }]))
      }
      throw new Error(`unexpected folder id ${folderId}`)
    })

    const { result } = renderHook(() => useDeleteJob())

    await act(async () => {
      await result.current.startDelete([{ type: 'folder', id: 'parent', name: 'Parent', sizeBytes: 12 }])
    })

    const deletedFileIds = mockDeleteFile.mock.calls.map((c) => c[0]).sort()
    expect(deletedFileIds).toEqual(['file-child', 'file-root'])

    // Child folder must be deleted before its parent.
    const deletedFolderIds = mockDeleteFolder.mock.calls.map((c) => c[0])
    expect(deletedFolderIds).toEqual(['child', 'parent'])

    expect(result.current.progress.status).toBe('complete')
    expect(result.current.progress.succeeded).toBe(1)
    expect(result.current.progress.failed).toBe(0)
  })

  test('marks the target failed and skips the folder delete when a content delete fails', async () => {
    mockGetFolder.mockResolvedValue(page([{ id: 'file-1', name: 'a.txt', size_bytes: 3 }]))
    mockDeleteFile.mockRejectedValueOnce(new Error('quota check failed'))

    const { result } = renderHook(() => useDeleteJob())

    await act(async () => {
      await result.current.startDelete([{ type: 'folder', id: 'parent', name: 'Parent', sizeBytes: 3 }])
    })

    expect(mockDeleteFolder).not.toHaveBeenCalled()
    expect(result.current.progress.status).toBe('allFailed')
    expect(result.current.progress.failed).toBe(1)
    expect(result.current.progress.items[0]).toMatchObject({ status: 'failed' })
  })

  test('reports the true recursive object count for a large folder, not just the one folder row', async () => {
    // 250 files split across two pages (page size is 200 internally) — the
    // exact scenario a ~10,000-message email backup folder hits, scaled down.
    const page1 = makeFiles('a', 200)
    const page2 = makeFiles('b', 50)
    mockGetFolder.mockImplementation((_folderId: string, opts: { fileCursor?: string }) =>
      Promise.resolve(opts.fileCursor ? page(page2) : page(page1, [], 'cursor-2')),
    )

    const { result } = renderHook(() => useDeleteJob())

    await act(async () => {
      await result.current.startDelete([{ type: 'folder', id: 'parent', name: 'Email backup', sizeBytes: 250 }])
    })

    expect(mockDeleteFile).toHaveBeenCalledTimes(250)
    expect(result.current.progress.totalObjects).toBe(250)
    expect(result.current.progress.doneObjects).toBe(250)
    expect(result.current.progress.loadedBytes).toBe(250)
    expect(result.current.progress.items[0]).toMatchObject({ status: 'done', loaded: 250 })
    expect(result.current.progress.status).toBe('complete')
  })

  test('tallies doneObjects/totalObjects across a mix of file and folder targets, even when one target partially fails', async () => {
    mockGetFolder.mockResolvedValue(page(makeFiles('m', 3, 10)))
    // The second of the three subtree files fails; the folder target as a
    // whole is then marked failed, but the two that did succeed still count.
    mockDeleteFile.mockImplementation((id: string) =>
      id === 'm1' ? Promise.reject(new Error('gone')) : Promise.resolve({ message: 'deleted' }),
    )

    const { result } = renderHook(() => useDeleteJob())

    let outcome: { succeeded: number; failed: number } | undefined
    await act(async () => {
      outcome = await result.current.startDelete([
        { type: 'file', id: 'solo', name: 'solo.txt', sizeBytes: 5 },
        { type: 'folder', id: 'parent', name: 'Parent', sizeBytes: 30 },
      ])
    })

    expect(outcome).toEqual({ succeeded: 1, failed: 1 })
    expect(result.current.progress.status).toBe('partial')
    // 1 standalone file + 3 in the folder's subtree = 4 total objects.
    expect(result.current.progress.totalObjects).toBe(4)
    // The standalone file + the 2 subtree files that didn't fail = 3 done.
    expect(result.current.progress.doneObjects).toBe(3)
    expect(mockDeleteFolder).not.toHaveBeenCalled()
  })

  test('fails an item with a timeout instead of hanging forever on a stuck request', async () => {
    jest.useFakeTimers()
    mockDeleteFile.mockImplementation(() => new Promise(() => {})) // never resolves

    const { result } = renderHook(() => useDeleteJob())

    let outcome: { succeeded: number; failed: number } | undefined
    await act(async () => {
      const p = result.current.startDelete([{ type: 'file', id: 'f1', name: 'a.txt', sizeBytes: 10 }])
      await jest.advanceTimersByTimeAsync(20_000)
      outcome = await p
    })

    expect(outcome).toEqual({ succeeded: 0, failed: 1 })
    expect(result.current.progress.status).toBe('allFailed')
    expect(result.current.progress.items[0]).toMatchObject({ status: 'failed' })
    expect(result.current.progress.items[0].error).toMatch(/Timed out/)

    jest.useRealTimers()
  })

  test('dismiss resets progress back to idle', async () => {
    const { result } = renderHook(() => useDeleteJob())

    await act(async () => {
      await result.current.startDelete([{ type: 'file', id: 'f1', name: 'a.txt', sizeBytes: 10 }])
    })
    expect(result.current.progress.status).toBe('complete')

    act(() => result.current.dismiss())
    expect(result.current.progress.status).toBe('idle')
  })
})
