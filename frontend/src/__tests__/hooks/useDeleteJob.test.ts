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

function page(files: { id: string; name: string; size_bytes: number }[], subfolders: { id: string }[] = []) {
  return {
    folder: null,
    subfolders: { items: subfolders, next_token: '' },
    files: { items: files, next_token: '' },
  }
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
