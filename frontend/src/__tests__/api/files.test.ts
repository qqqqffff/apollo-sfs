import {
  initChunkedUpload,
  uploadChunk,
  completeChunkedUpload,
  getFile,
  uploadFile,
  renameFile,
  deleteFile,
  moveFile,
  downloadUrl,
  previewUrl,
  streamUrl,
  fileQueryOptions,
  CHUNK_SIZE,
} from '../../api/files'

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

// Minimal XHR mock — enough for uploadChunk / uploadFile tests
class MockXHR {
  upload = { addEventListener: jest.fn() }
  _listeners: Record<string, ((e?: unknown) => void)[]> = {}
  open = jest.fn()
  send = jest.fn()
  withCredentials = false
  status = 200
  statusText = 'OK'
  responseText = ''
  addEventListener(event: string, fn: (e?: unknown) => void) {
    if (!this._listeners[event]) this._listeners[event] = []
    this._listeners[event].push(fn)
  }
  _trigger(event: string) {
    for (const fn of this._listeners[event] ?? []) fn()
  }
}

describe('CHUNK_SIZE', () => {
  it('is 5 MB', () => {
    expect(CHUNK_SIZE).toBe(5 * 1024 * 1024)
  })
})

describe('initChunkedUpload', () => {
  it('POSTs to /files/upload/init with correct payload', async () => {
    mockFetch(200, { upload_id: 'up-1' })
    const result = await initChunkedUpload('video.mp4', 3, 15_000_000, 'folder-1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/files/upload/init')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'video.mp4',
      total_chunks: 3,
      total_size: 15_000_000,
      folder_id: 'folder-1',
    })
    expect(result).toEqual({ upload_id: 'up-1' })
  })

  it('sends folder_id as undefined when null is passed', async () => {
    mockFetch(200, { upload_id: 'up-2' })
    await initChunkedUpload('doc.pdf', 1, 1000, null)
    const body = JSON.parse(lastCall()[1].body as string)
    expect(body.folder_id).toBeUndefined()
  })
})

describe('uploadChunk', () => {
  let xhrInstance: MockXHR

  beforeEach(() => {
    xhrInstance = new MockXHR()
    global.XMLHttpRequest = jest.fn(() => xhrInstance) as unknown as typeof XMLHttpRequest
  })

  it('sends chunk to /files/upload/:id/chunk via XHR', async () => {
    xhrInstance.status = 200
    xhrInstance.responseText = JSON.stringify({ chunk_index: 0, dispatched: 1, total: 3 })
    const chunk = new Blob(['data'])
    const p = uploadChunk('up-1', 0, chunk, () => {})
    xhrInstance._trigger('load')
    await p
    expect(xhrInstance.open).toHaveBeenCalledWith('POST', '/api/v1/files/upload/up-1/chunk')
    const [formData] = xhrInstance.send.mock.calls[0]
    expect(formData.get('chunk_index')).toBe('0')
  })
})

describe('completeChunkedUpload', () => {
  it('POSTs to /files/upload/:id/complete', async () => {
    mockFetch(200, { file: { id: 'f1', name: 'video.mp4' } })
    await completeChunkedUpload('up-1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/files/upload/up-1/complete')
    expect(init.method).toBe('POST')
  })
})

describe('getFile', () => {
  it('GETs /files/:id', async () => {
    mockFetch(200, { id: 'f1', name: 'photo.jpg' })
    const result = await getFile('f1')
    const [url] = lastCall()
    expect(url).toBe('/api/v1/files/f1')
    expect(result).toMatchObject({ id: 'f1', name: 'photo.jpg' })
  })
})

describe('uploadFile', () => {
  it('uses fetch-based upload when no onProgress provided', async () => {
    mockFetch(200, { file: { id: 'f2' } })
    const file = new File(['content'], 'test.txt', { type: 'text/plain' })
    await uploadFile('folder-1', file)
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/files/upload')
    expect(init.method).toBe('POST')
    const fd = init.body as FormData
    expect(fd.get('folder_id')).toBe('folder-1')
  })

  it('uses XHR-based upload when onProgress is provided', () => {
    const xhrInstance = new MockXHR()
    global.XMLHttpRequest = jest.fn(() => xhrInstance) as unknown as typeof XMLHttpRequest
    const file = new File(['content'], 'test.txt')
    uploadFile(null, file, () => {})
    expect(xhrInstance.open).toHaveBeenCalledWith('POST', '/api/v1/files/upload')
  })

  it('appends custom name to FormData when provided', async () => {
    mockFetch(200, { file: { id: 'f3' } })
    const file = new File(['x'], 'original.txt')
    await uploadFile(null, file, undefined, 'renamed.txt')
    const fd = lastCall()[1].body as FormData
    expect(fd.get('name')).toBe('renamed.txt')
  })
})

describe('renameFile', () => {
  it('PATCHes /files/:id with new name', async () => {
    mockFetch(200, { id: 'f1', name: 'new-name.txt' })
    await renameFile('f1', 'new-name.txt')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/files/f1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'new-name.txt' })
  })
})

describe('deleteFile', () => {
  it('DELETEs /files/:id', async () => {
    mockFetch(200, { message: 'deleted' })
    await deleteFile('f1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/files/f1')
    expect(init.method).toBe('DELETE')
  })
})

describe('moveFile', () => {
  it('PATCHes /files/:id/move with target folder id', async () => {
    mockFetch(200, { id: 'f1', folder_id: 'folder-2' })
    await moveFile('f1', 'folder-2')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/files/f1/move')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ folder_id: 'folder-2' })
  })
})

describe('URL helpers', () => {
  it('downloadUrl returns correct path', () => {
    expect(downloadUrl('f1')).toBe('/api/v1/files/f1/download')
  })

  it('previewUrl returns correct path', () => {
    expect(previewUrl('f1')).toBe('/api/v1/files/f1/preview')
  })

  it('streamUrl returns path without quality', () => {
    expect(streamUrl('f1')).toBe('/api/v1/files/f1/stream')
  })

  it('streamUrl appends quality param when provided', () => {
    expect(streamUrl('f1', 'low')).toBe('/api/v1/files/f1/stream?quality=low')
  })
})

describe('fileQueryOptions', () => {
  it('has correct queryKey and queryFn', () => {
    mockFetch(200, { id: 'f1' })
    const opts = fileQueryOptions('f1')
    expect(opts.queryKey).toEqual(['files', 'f1'])
    opts.queryFn()
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('/api/v1/files/f1')
  })
})
