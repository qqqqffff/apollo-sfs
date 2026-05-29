import { ApiError, get, post, patch, put, del, upload, uploadWithProgress } from '../../api/client'

// ── helpers ───────────────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: jest.fn().mockResolvedValue(body),
    headers: new Headers(headers),
  }
  global.fetch = jest.fn().mockResolvedValue(response)
  return response
}

function lastFetch() {
  return (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit | undefined]
}

// ── ApiError ──────────────────────────────────────────────────────────────────

describe('ApiError', () => {
  it('sets status, message, and name', () => {
    const err = new ApiError(404, 'not found', { detail: 'x' })
    expect(err.status).toBe(404)
    expect(err.message).toBe('not found')
    expect(err.name).toBe('ApiError')
    expect(err.body).toEqual({ detail: 'x' })
  })

  it('defaults body to empty object', () => {
    const err = new ApiError(500, 'oops')
    expect(err.body).toEqual({})
  })
})

// ── get ───────────────────────────────────────────────────────────────────────

describe('get', () => {
  it('calls fetch with GET and correct URL', async () => {
    mockFetch(200, { id: 1 })
    await get('/test')
    const [url, init] = lastFetch()
    expect(url).toBe('/api/v1/test')
    expect(init?.method).toBeUndefined()
  })

  it('returns parsed JSON', async () => {
    mockFetch(200, { value: 42 })
    const result = await get<{ value: number }>('/data')
    expect(result).toEqual({ value: 42 })
  })

  it('includes credentials and Content-Type header', async () => {
    mockFetch(200, {})
    await get('/x')
    const [, init] = lastFetch()
    expect(init?.credentials).toBe('include')
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('throws ApiError on non-ok response', async () => {
    mockFetch(404, { error: 'not found' })
    await expect(get('/missing')).rejects.toThrow(ApiError)
  })

  it('ApiError carries status and message from body.error', async () => {
    mockFetch(404, { error: 'resource gone' })
    const err = await get('/x').catch((e) => e) as ApiError
    expect(err.status).toBe(404)
    expect(err.message).toBe('resource gone')
  })

  it('falls back to statusText when body.error is missing', async () => {
    const res = {
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: jest.fn().mockResolvedValue({}),
    }
    global.fetch = jest.fn().mockResolvedValue(res)
    const err = await get('/x').catch((e) => e) as ApiError
    expect(err.message).toBe('Service Unavailable')
  })

  it('returns undefined for 204 No Content', async () => {
    const res = { ok: true, status: 204, statusText: 'No Content', json: jest.fn() }
    global.fetch = jest.fn().mockResolvedValue(res)
    const result = await get('/empty')
    expect(result).toBeUndefined()
    expect(res.json).not.toHaveBeenCalled()
  })

  it('dispatches apollo:session-expired on 401', async () => {
    mockFetch(401, { error: 'unauthorized' })
    const listener = jest.fn()
    window.addEventListener('apollo:session-expired', listener)
    await get('/protected').catch(() => {})
    window.removeEventListener('apollo:session-expired', listener)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch session-expired on non-401 errors', async () => {
    mockFetch(403, { error: 'forbidden' })
    const listener = jest.fn()
    window.addEventListener('apollo:session-expired', listener)
    await get('/protected').catch(() => {})
    window.removeEventListener('apollo:session-expired', listener)
    expect(listener).not.toHaveBeenCalled()
  })
})

// ── post ──────────────────────────────────────────────────────────────────────

describe('post', () => {
  it('sends POST with JSON body', async () => {
    mockFetch(200, { ok: true })
    await post('/action', { key: 'val' })
    const [url, init] = lastFetch()
    expect(url).toBe('/api/v1/action')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify({ key: 'val' }))
  })

  it('sends POST with no body when body is undefined', async () => {
    mockFetch(200, {})
    await post('/no-body')
    const [, init] = lastFetch()
    expect(init?.body).toBeUndefined()
  })
})

// ── patch ─────────────────────────────────────────────────────────────────────

describe('patch', () => {
  it('sends PATCH with JSON body', async () => {
    mockFetch(200, { updated: true })
    await patch('/resource/1', { name: 'new' })
    const [url, init] = lastFetch()
    expect(url).toBe('/api/v1/resource/1')
    expect(init?.method).toBe('PATCH')
    expect(init?.body).toBe(JSON.stringify({ name: 'new' }))
  })
})

// ── put ───────────────────────────────────────────────────────────────────────

describe('put', () => {
  it('sends PUT with JSON body', async () => {
    mockFetch(200, { replaced: true })
    await put('/resource/1', { value: 99 })
    const [, init] = lastFetch()
    expect(init?.method).toBe('PUT')
    expect(init?.body).toBe(JSON.stringify({ value: 99 }))
  })
})

// ── del ───────────────────────────────────────────────────────────────────────

describe('del', () => {
  it('sends DELETE with no body', async () => {
    mockFetch(200, { message: 'deleted' })
    await del('/resource/1')
    const [url, init] = lastFetch()
    expect(url).toBe('/api/v1/resource/1')
    expect(init?.method).toBe('DELETE')
  })
})

// ── upload ────────────────────────────────────────────────────────────────────

describe('upload', () => {
  it('sends POST with FormData and no Content-Type header', async () => {
    mockFetch(200, { file_id: 'f1' })
    const form = new FormData()
    form.append('file', new Blob(['hi']))
    await upload('/files/upload', form)
    const [url, init] = lastFetch()
    expect(url).toBe('/api/v1/files/upload')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(form)
    expect((init?.headers as Record<string, string> | undefined)?.['Content-Type']).toBeUndefined()
  })

  it('throws ApiError on non-ok response', async () => {
    mockFetch(413, { error: 'too large' })
    await expect(upload('/files/upload', new FormData())).rejects.toThrow(ApiError)
  })

  it('dispatches session-expired on 401 from upload', async () => {
    mockFetch(401, { error: 'unauthorized' })
    const listener = jest.fn()
    window.addEventListener('apollo:session-expired', listener)
    await upload('/files/upload', new FormData()).catch(() => {})
    window.removeEventListener('apollo:session-expired', listener)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

// ── uploadWithProgress ────────────────────────────────────────────────────────

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

  _trigger(event: string, data?: unknown) {
    for (const fn of this._listeners[event] ?? []) fn(data)
  }
}

describe('uploadWithProgress', () => {
  let xhrInstance: MockXHR

  beforeEach(() => {
    xhrInstance = new MockXHR()
    global.XMLHttpRequest = jest.fn(() => xhrInstance) as unknown as typeof XMLHttpRequest
  })

  it('opens POST to the correct URL with credentials', () => {
    uploadWithProgress('/files/upload', new FormData(), () => {})
    expect(xhrInstance.open).toHaveBeenCalledWith('POST', '/api/v1/files/upload')
    expect(xhrInstance.withCredentials).toBe(true)
  })

  it('calls send with the FormData', () => {
    const form = new FormData()
    uploadWithProgress('/files/upload', form, () => {})
    expect(xhrInstance.send).toHaveBeenCalledWith(form)
  })

  it('resolves with parsed JSON on success', async () => {
    xhrInstance.responseText = JSON.stringify({ file_id: 'f1' })
    xhrInstance.status = 200
    const p = uploadWithProgress<{ file_id: string }>('/upload', new FormData(), () => {})
    xhrInstance._trigger('load')
    const result = await p
    expect(result).toEqual({ file_id: 'f1' })
  })

  it('calls onProgress with loaded/total', () => {
    const onProgress = jest.fn()
    uploadWithProgress('/upload', new FormData(), onProgress)

    // Simulate upload.progress event
    const progressCall = (xhrInstance.upload.addEventListener as jest.Mock).mock.calls
      .find(([event]: [string]) => event === 'progress')
    const handler = progressCall?.[1]
    handler?.({ lengthComputable: true, loaded: 500, total: 1000 })
    expect(onProgress).toHaveBeenCalledWith(500, 1000)
  })

  it('rejects with ApiError on non-2xx status', async () => {
    xhrInstance.status = 413
    xhrInstance.statusText = 'Too Large'
    xhrInstance.responseText = JSON.stringify({ error: 'file too large' })
    const p = uploadWithProgress('/upload', new FormData(), () => {})
    xhrInstance._trigger('load')
    const err = await p.catch((e) => e) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(413)
    expect(err.message).toBe('file too large')
  })

  it('dispatches session-expired on 401 from XHR', async () => {
    xhrInstance.status = 401
    xhrInstance.responseText = JSON.stringify({ error: 'unauthorized' })
    const listener = jest.fn()
    window.addEventListener('apollo:session-expired', listener)
    const p = uploadWithProgress('/upload', new FormData(), () => {})
    xhrInstance._trigger('load')
    await p.catch(() => {})
    window.removeEventListener('apollo:session-expired', listener)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('rejects with network error on XHR error event', async () => {
    const p = uploadWithProgress('/upload', new FormData(), () => {})
    xhrInstance._trigger('error')
    const err = await p.catch((e) => e) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(0)
    expect(err.message).toBe('Network error')
  })

  it('rejects with Cancelled on abort', async () => {
    const p = uploadWithProgress('/upload', new FormData(), () => {})
    xhrInstance._trigger('abort')
    const err = await p.catch((e) => e) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toBe('Cancelled')
  })
})
