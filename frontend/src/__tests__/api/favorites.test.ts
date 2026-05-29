import {
  getFavorites,
  favoriteFile,
  unfavoriteFile,
  favoriteFolder,
  unfavoriteFolder,
  favoritesQueryOptions,
} from '../../api/favorites'

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: jest.fn().mockResolvedValue(body),
  })
}

function mock204() {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 204,
    statusText: 'No Content',
    json: jest.fn(),
  })
}

function lastCall() {
  return (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
}

const EMPTY_FAVORITES = { folders: [], files: [] }

describe('getFavorites', () => {
  it('GETs /favorites', async () => {
    mockFetch(200, EMPTY_FAVORITES)
    const result = await getFavorites()
    const [url] = lastCall()
    expect(url).toBe('/api/v1/favorites')
    expect(result).toEqual(EMPTY_FAVORITES)
  })
})

describe('favoriteFile', () => {
  it('POSTs to /favorites/files/:id', async () => {
    mock204()
    await favoriteFile('f1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/favorites/files/f1')
    expect(init.method).toBe('POST')
  })
})

describe('unfavoriteFile', () => {
  it('DELETEs /favorites/files/:id', async () => {
    mock204()
    await unfavoriteFile('f1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/favorites/files/f1')
    expect(init.method).toBe('DELETE')
  })
})

describe('favoriteFolder', () => {
  it('POSTs to /favorites/folders/:id', async () => {
    mock204()
    await favoriteFolder('fold-1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/favorites/folders/fold-1')
    expect(init.method).toBe('POST')
  })
})

describe('unfavoriteFolder', () => {
  it('DELETEs /favorites/folders/:id', async () => {
    mock204()
    await unfavoriteFolder('fold-1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/favorites/folders/fold-1')
    expect(init.method).toBe('DELETE')
  })
})

describe('favoritesQueryOptions', () => {
  it('has correct queryKey', () => {
    expect(favoritesQueryOptions.queryKey).toEqual(['favorites'])
  })

  it('queryFn calls getFavorites', () => {
    mockFetch(200, EMPTY_FAVORITES)
    favoritesQueryOptions.queryFn()
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('/api/v1/favorites')
  })
})
