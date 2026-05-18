import {
  listRoot,
  getFolder,
  createFolder,
  renameFolder,
  moveFolder,
  deleteFolder,
  rootQueryOptions,
  folderQueryOptions,
} from '../../api/folders'

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: jest.fn().mockResolvedValue(body),
  })
}

function lastCall() {
  return (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
}

const EMPTY_CONTENTS = {
  folder: null,
  subfolders: { items: [], next_token: '' },
  files: { items: [], next_token: '' },
}

describe('listRoot', () => {
  it('GETs /folders with no params', async () => {
    mockFetch(200, EMPTY_CONTENTS)
    await listRoot()
    const [url] = lastCall()
    expect(url).toBe('/api/v1/folders')
  })

  it('appends folder_cursor and file_cursor query params', async () => {
    mockFetch(200, EMPTY_CONTENTS)
    await listRoot({ folderCursor: 'fc1', fileCursor: 'fc2' })
    const [url] = lastCall()
    expect(url).toBe('/api/v1/folders?folder_cursor=fc1&file_cursor=fc2')
  })

  it('appends folder_limit and file_limit', async () => {
    mockFetch(200, EMPTY_CONTENTS)
    await listRoot({ folderLimit: 10, fileLimit: 20 })
    const [url] = lastCall()
    expect(url).toBe('/api/v1/folders?folder_limit=10&file_limit=20')
  })

  it('returns parsed folder contents', async () => {
    mockFetch(200, EMPTY_CONTENTS)
    const result = await listRoot()
    expect(result).toEqual(EMPTY_CONTENTS)
  })
})

describe('getFolder', () => {
  it('GETs /folders/:id', async () => {
    mockFetch(200, EMPTY_CONTENTS)
    await getFolder('fold-1')
    const [url] = lastCall()
    expect(url).toBe('/api/v1/folders/fold-1')
  })

  it('appends pagination params', async () => {
    mockFetch(200, EMPTY_CONTENTS)
    await getFolder('fold-1', { folderCursor: 'next', fileLimit: 5 })
    const [url] = lastCall()
    expect(url).toBe('/api/v1/folders/fold-1?folder_cursor=next&file_limit=5')
  })
})

describe('createFolder', () => {
  it('POSTs to /folders with name and null parent', async () => {
    mockFetch(200, { id: 'fold-new', name: 'Photos' })
    await createFolder('Photos')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/folders')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Photos', parent_id: null })
  })

  it('includes parent_id when provided', async () => {
    mockFetch(200, { id: 'fold-child', name: 'Sub' })
    await createFolder('Sub', 'fold-parent')
    const body = JSON.parse(lastCall()[1].body as string)
    expect(body.parent_id).toBe('fold-parent')
  })
})

describe('renameFolder', () => {
  it('PATCHes /folders/:id with new name', async () => {
    mockFetch(200, { id: 'fold-1', name: 'Renamed' })
    await renameFolder('fold-1', 'Renamed')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/folders/fold-1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Renamed' })
  })
})

describe('moveFolder', () => {
  it('PATCHes /folders/:id/move with target folder id', async () => {
    mockFetch(200, { id: 'fold-1' })
    await moveFolder('fold-1', 'fold-target')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/folders/fold-1/move')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ target_folder_id: 'fold-target' })
  })
})

describe('deleteFolder', () => {
  it('DELETEs /folders/:id', async () => {
    mockFetch(200, { message: 'deleted' })
    await deleteFolder('fold-1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/folders/fold-1')
    expect(init.method).toBe('DELETE')
  })
})

describe('rootQueryOptions', () => {
  it('has correct queryKey', () => {
    expect(rootQueryOptions.queryKey).toEqual(['folders', 'root'])
  })

  it('queryFn calls listRoot', () => {
    mockFetch(200, EMPTY_CONTENTS)
    rootQueryOptions.queryFn()
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('/api/v1/folders')
  })
})

describe('folderQueryOptions', () => {
  it('has correct queryKey with folder id', () => {
    const opts = folderQueryOptions('fold-1')
    expect(opts.queryKey).toEqual(['folders', 'fold-1'])
  })

  it('queryFn calls getFolder', () => {
    mockFetch(200, EMPTY_CONTENTS)
    const opts = folderQueryOptions('fold-1')
    opts.queryFn()
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('/api/v1/folders/fold-1')
  })
})
