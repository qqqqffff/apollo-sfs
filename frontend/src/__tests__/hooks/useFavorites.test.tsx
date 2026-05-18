import React from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useFavorites } from '../../hooks/useFavorites'
import type { FavoriteList } from '../../types/api'

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('../../api/favorites', () => ({
  favoritesQueryOptions: {
    queryKey: ['favorites'] as const,
    queryFn: jest.fn().mockResolvedValue({ files: [], folders: [] }),
  },
  favoriteFile:     jest.fn(),
  unfavoriteFile:   jest.fn(),
  favoriteFolder:   jest.fn(),
  unfavoriteFolder: jest.fn(),
}))

import {
  favoriteFile,
  unfavoriteFile,
  favoriteFolder,
  unfavoriteFolder,
} from '../../api/favorites'

const mockFavoriteFile    = favoriteFile    as jest.Mock
const mockUnfavoriteFile  = unfavoriteFile  as jest.Mock
const mockFavoriteFolder  = favoriteFolder  as jest.Mock
const mockUnfavoriteFolder = unfavoriteFolder as jest.Mock

const LIST: FavoriteList = {
  files:   [{ id: 'f1', user_id: 'u1', name: 'photo.jpg', mime_type: 'image/jpeg', size_bytes: 100, created_at: '', updated_at: '', folder_id: null }],
  folders: [{ id: 'fold-1', user_id: 'u1', name: 'Docs', created_at: '', updated_at: '', parent_id: null }],
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

function makeClient(initialData?: FavoriteList) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  if (initialData) {
    client.setQueryData(['favorites'], initialData)
  }
  return client
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useFavorites — derived sets', () => {
  it('favoriteFileIds is populated from query data', () => {
    const client = makeClient(LIST)
    const { result } = renderHook(() => useFavorites(), { wrapper: makeWrapper(client) })
    expect(result.current.favoriteFileIds.has('f1')).toBe(true)
  })

  it('favoriteFolderIds is populated from query data', () => {
    const client = makeClient(LIST)
    const { result } = renderHook(() => useFavorites(), { wrapper: makeWrapper(client) })
    expect(result.current.favoriteFolderIds.has('fold-1')).toBe(true)
  })

  it('sets are empty when there is no query data', () => {
    const client = makeClient()
    const { result } = renderHook(() => useFavorites(), { wrapper: makeWrapper(client) })
    expect(result.current.favoriteFileIds.size).toBe(0)
    expect(result.current.favoriteFolderIds.size).toBe(0)
  })
})

describe('useFavorites — toggleFile', () => {
  beforeEach(() => {
    mockFavoriteFile.mockResolvedValue(undefined)
    mockUnfavoriteFile.mockResolvedValue(undefined)
  })

  it('calls favoriteFile when file is not yet favorited', async () => {
    const client = makeClient({ files: [], folders: [] })
    const { result } = renderHook(() => useFavorites(), { wrapper: makeWrapper(client) })
    act(() => result.current.toggleFile('f-new'))
    await waitFor(() => expect(mockFavoriteFile).toHaveBeenCalled())
    expect(mockFavoriteFile.mock.calls[0][0]).toBe('f-new')
  })

  it('calls unfavoriteFile when file is already favorited', async () => {
    const client = makeClient(LIST)
    const { result } = renderHook(() => useFavorites(), { wrapper: makeWrapper(client) })
    act(() => result.current.toggleFile('f1'))
    await waitFor(() => expect(mockUnfavoriteFile).toHaveBeenCalled())
    expect(mockUnfavoriteFile.mock.calls[0][0]).toBe('f1')
  })

  it('optimistically removes the file from cache when unfavoriting', async () => {
    const client = makeClient(LIST)
    mockUnfavoriteFile.mockResolvedValue(undefined)
    const { result } = renderHook(() => useFavorites(), { wrapper: makeWrapper(client) })
    act(() => result.current.toggleFile('f1'))
    await waitFor(() => {
      const cached = client.getQueryData<FavoriteList>(['favorites'])
      expect(cached?.files.find(f => f.id === 'f1')).toBeUndefined()
    })
  })
})

describe('useFavorites — toggleFolder', () => {
  beforeEach(() => {
    mockFavoriteFolder.mockResolvedValue(undefined)
    mockUnfavoriteFolder.mockResolvedValue(undefined)
  })

  it('calls favoriteFolder when folder is not yet favorited', async () => {
    const client = makeClient({ files: [], folders: [] })
    const { result } = renderHook(() => useFavorites(), { wrapper: makeWrapper(client) })
    act(() => result.current.toggleFolder('fold-new'))
    await waitFor(() => expect(mockFavoriteFolder).toHaveBeenCalled())
    expect(mockFavoriteFolder.mock.calls[0][0]).toBe('fold-new')
  })

  it('calls unfavoriteFolder when folder is already favorited', async () => {
    const client = makeClient(LIST)
    const { result } = renderHook(() => useFavorites(), { wrapper: makeWrapper(client) })
    act(() => result.current.toggleFolder('fold-1'))
    await waitFor(() => expect(mockUnfavoriteFolder).toHaveBeenCalled())
    expect(mockUnfavoriteFolder.mock.calls[0][0]).toBe('fold-1')
  })

  it('optimistically removes the folder from cache when unfavoriting', async () => {
    const client = makeClient(LIST)
    mockUnfavoriteFolder.mockResolvedValue(undefined)
    const { result } = renderHook(() => useFavorites(), { wrapper: makeWrapper(client) })
    act(() => result.current.toggleFolder('fold-1'))
    await waitFor(() => {
      const cached = client.getQueryData<FavoriteList>(['favorites'])
      expect(cached?.folders.find(f => f.id === 'fold-1')).toBeUndefined()
    })
  })
})
