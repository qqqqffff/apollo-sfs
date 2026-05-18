import React from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useInfiniteFolderContents } from '../../hooks/useInfiniteFolderContents'
import type { FolderContents } from '../../types/api'

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('../../api/folders', () => ({
  listRoot:   jest.fn(),
  getFolder:  jest.fn(),
}))

jest.mock('../../api/search', () => ({
  searchContent: jest.fn(),
}))

import { listRoot, getFolder } from '../../api/folders'
import { searchContent } from '../../api/search'

const mockListRoot      = listRoot      as jest.Mock
const mockGetFolder     = getFolder     as jest.Mock
const mockSearchContent = searchContent as jest.Mock

// ── Helpers ───────────────────────────────────────────────────────────────────

function page(
  folders: { id: string; name: string }[],
  files: { id: string; name: string }[],
  nextFolderToken = '',
  nextFileToken = '',
): FolderContents {
  return {
    folder: null,
    subfolders: {
      items: folders.map(f => ({ ...f, user_id: 'u1', created_at: '', updated_at: '', parent_id: null })),
      next_token: nextFolderToken,
    },
    files: {
      items: files.map(f => ({ ...f, user_id: 'u1', mime_type: 'text/plain', size_bytes: 100, created_at: '', updated_at: '', folder_id: null })),
      next_token: nextFileToken,
    },
  }
}

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return {
    client,
    wrapper: function Wrapper({ children }: { children: React.ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>
    },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useInfiniteFolderContents', () => {
  beforeEach(() => {
    mockListRoot.mockReset()
    mockGetFolder.mockReset()
    mockSearchContent.mockReset()
  })

  it('starts in loading state with empty arrays', () => {
    mockListRoot.mockResolvedValue(page([], []))
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useInfiniteFolderContents('root', ''), { wrapper })
    expect(result.current.isLoading).toBe(true)
    expect(result.current.folders).toEqual([])
    expect(result.current.files).toEqual([])
  })

  it('calls listRoot for folderId=root', async () => {
    mockListRoot.mockResolvedValue(page([], []))
    const { wrapper } = makeWrapper()
    renderHook(() => useInfiniteFolderContents('root', ''), { wrapper })
    await waitFor(() => expect(mockListRoot).toHaveBeenCalledTimes(1))
  })

  it('calls getFolder for a non-root folderId', async () => {
    mockGetFolder.mockResolvedValue(page([], []))
    const { wrapper } = makeWrapper()
    renderHook(() => useInfiniteFolderContents('fold-1', ''), { wrapper })
    await waitFor(() => expect(mockGetFolder).toHaveBeenCalledWith('fold-1', expect.any(Object)))
  })

  it('calls searchContent when search is non-empty', async () => {
    mockSearchContent.mockResolvedValue(page([], []))
    const { wrapper } = makeWrapper()
    renderHook(() => useInfiniteFolderContents('root', 'hello'), { wrapper })
    await waitFor(() => expect(mockSearchContent).toHaveBeenCalledWith('hello', expect.any(Object)))
  })

  it('flattens folders from pages', async () => {
    mockListRoot.mockResolvedValue(page([{ id: 'fold-a', name: 'Alpha' }, { id: 'fold-b', name: 'Beta' }], []))
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useInfiniteFolderContents('root', ''), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.folders.map(f => f.id)).toEqual(['fold-a', 'fold-b'])
  })

  it('flattens files from pages', async () => {
    mockListRoot.mockResolvedValue(page([], [{ id: 'f1', name: 'doc.pdf' }, { id: 'f2', name: 'img.png' }]))
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useInfiniteFolderContents('root', ''), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.files.map(f => f.id)).toEqual(['f1', 'f2'])
  })

  it('hasNextPage is false when both cursors are empty', async () => {
    mockListRoot.mockResolvedValue(page([{ id: 'fold-1', name: 'A' }], [], '', ''))
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useInfiniteFolderContents('root', ''), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.hasNextPage).toBe(false)
  })

  it('hasNextPage is true when a next_token is present', async () => {
    mockListRoot.mockResolvedValue(page([], [{ id: 'f1', name: 'a.txt' }], '', 'tok-next'))
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useInfiniteFolderContents('root', ''), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.hasNextPage).toBe(true)
  })

  it('auto-fetches next page when current page returns zero items but more exist', async () => {
    // First page: empty items but has more
    mockListRoot
      .mockResolvedValueOnce(page([], [], 'tok-next', ''))
      .mockResolvedValue(page([{ id: 'fold-found', name: 'Found' }], [], '', ''))
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useInfiniteFolderContents('root', ''), { wrapper })
    await waitFor(() => {
      expect(result.current.folders.length).toBeGreaterThan(0)
    })
    expect(result.current.folders[0].id).toBe('fold-found')
  })

  it('exposes error when query fails', async () => {
    const err = new Error('network error')
    mockListRoot.mockRejectedValue(err)
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useInfiniteFolderContents('root', ''), { wrapper })
    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.error?.message).toBe('network error')
  })

  it('exposes fetchNextPage function', async () => {
    mockListRoot.mockResolvedValue(page([], [], 'tok', ''))
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useInfiniteFolderContents('root', ''), { wrapper })
    await waitFor(() => !result.current.isLoading)
    expect(typeof result.current.fetchNextPage).toBe('function')
  })
})
