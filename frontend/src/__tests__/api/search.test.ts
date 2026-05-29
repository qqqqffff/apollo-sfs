import { searchContent } from '../../api/search'

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: jest.fn().mockResolvedValue(body),
  })
}

function lastUrl() {
  return (global.fetch as jest.Mock).mock.calls[0][0] as string
}

const EMPTY_RESULTS = {
  folder: null,
  subfolders: { items: [], next_token: '' },
  files: { items: [], next_token: '' },
}

describe('searchContent', () => {
  it('GETs /search with query param', async () => {
    mockFetch(200, EMPTY_RESULTS)
    await searchContent('hello')
    expect(lastUrl()).toBe('/api/v1/search?q=hello')
  })

  it('URL-encodes the query string', async () => {
    mockFetch(200, EMPTY_RESULTS)
    await searchContent('my file.txt')
    expect(lastUrl()).toBe('/api/v1/search?q=my+file.txt')
  })

  it('appends folder_cursor when provided', async () => {
    mockFetch(200, EMPTY_RESULTS)
    await searchContent('doc', { folderCursor: 'curs-1' })
    const url = lastUrl()
    expect(url).toContain('q=doc')
    expect(url).toContain('folder_cursor=curs-1')
  })

  it('appends file_cursor when provided', async () => {
    mockFetch(200, EMPTY_RESULTS)
    await searchContent('img', { fileCursor: 'curs-2' })
    expect(lastUrl()).toContain('file_cursor=curs-2')
  })

  it('appends folder_limit and file_limit when provided', async () => {
    mockFetch(200, EMPTY_RESULTS)
    await searchContent('x', { folderLimit: 5, fileLimit: 10 })
    const url = lastUrl()
    expect(url).toContain('folder_limit=5')
    expect(url).toContain('file_limit=10')
  })

  it('returns parsed search results', async () => {
    const results = {
      folder: null,
      subfolders: { items: [{ id: 'fold-1', name: 'Docs' }], next_token: '' },
      files: { items: [{ id: 'f1', name: 'doc.pdf' }], next_token: '' },
    }
    mockFetch(200, results)
    const data = await searchContent('doc')
    expect(data).toEqual(results)
  })
})
