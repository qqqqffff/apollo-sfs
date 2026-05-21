import { copyToCollection, moveCollectionItem, removeFromCollection } from '../../api/collections'
import { getMediaFolder } from '../../api/folders'
import { hideFile, unhideFile } from '../../api/files'
import { getPreferences, updatePreferences } from '../../api/me'

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

describe('getMediaFolder', () => {
  it('GETs the media endpoint with default params', async () => {
    mockFetch(200, EMPTY_CONTENTS)
    await getMediaFolder('col-1')
    expect(lastCall()[0]).toBe('/api/v1/folders/col-1/media')
  })

  it('appends sort and hidden=show', async () => {
    mockFetch(200, EMPTY_CONTENTS)
    await getMediaFolder('col-1', { sort: 'taken_at', hidden: 'show' })
    const [url] = lastCall()
    expect(url).toContain('sort=taken_at')
    expect(url).toContain('hidden=show')
  })

  it('maps hidden=only to the only filter', async () => {
    mockFetch(200, EMPTY_CONTENTS)
    await getMediaFolder('col-1', { hidden: 'only' })
    expect(lastCall()[0]).toContain('hidden=only')
  })

  it('omits hidden param when set to hide (default)', async () => {
    mockFetch(200, EMPTY_CONTENTS)
    await getMediaFolder('col-1', { hidden: 'hide' })
    expect(lastCall()[0]).not.toContain('hidden=')
  })
})

describe('hide / unhide', () => {
  it('PATCHes the hide endpoint', async () => {
    mockFetch(200, {})
    await hideFile('f1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/files/f1/hide')
    expect(init.method).toBe('PATCH')
  })

  it('PATCHes the unhide endpoint', async () => {
    mockFetch(200, {})
    await unhideFile('f1')
    expect(lastCall()[0]).toBe('/api/v1/files/f1/unhide')
  })
})

describe('collection pointers', () => {
  it('POSTs a copy', async () => {
    mockFetch(201, { message: 'ok' })
    await copyToCollection('col-1', 'f1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/collections/col-1/items/f1')
    expect(init.method).toBe('POST')
  })

  it('PATCHes a move with target_collection_id', async () => {
    mockFetch(200, { message: 'ok' })
    await moveCollectionItem('col-1', 'f1', 'col-2')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/collections/col-1/items/f1/move')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ target_collection_id: 'col-2' })
  })

  it('DELETEs a pointer', async () => {
    mockFetch(200, { message: 'ok' })
    await removeFromCollection('col-1', 'f1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/collections/col-1/items/f1')
    expect(init.method).toBe('DELETE')
  })
})

describe('preferences', () => {
  it('GETs preferences', async () => {
    mockFetch(200, { user_id: 'u1', media_autoupload_folder_id: null })
    await getPreferences()
    expect(lastCall()[0]).toBe('/api/v1/me/preferences')
  })

  it('PUTs the chosen folder id', async () => {
    mockFetch(200, { user_id: 'u1', media_autoupload_folder_id: 'col-1' })
    await updatePreferences('col-1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/me/preferences')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ media_autoupload_folder_id: 'col-1' })
  })

  it('PUTs null to disable', async () => {
    mockFetch(200, { user_id: 'u1', media_autoupload_folder_id: null })
    await updatePreferences(null)
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ media_autoupload_folder_id: null })
  })
})
