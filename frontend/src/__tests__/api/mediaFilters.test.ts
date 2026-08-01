import { getMediaFileIds, getMediaFolder } from '../../api/folders'
import { EMPTY_MEDIA_FILTERS, countMediaFilters } from '../../types/api'
import type { MediaFilters } from '../../types/api'

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: jest.fn().mockResolvedValue(body),
  })
}

function lastUrl(): string {
  return ((global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit])[0]
}

function query(url: string): URLSearchParams {
  return new URLSearchParams(url.slice(url.indexOf('?') + 1))
}

const EMPTY_CONTENTS = {
  folder: null,
  subfolders: { items: [], next_token: '' },
  files: { items: [], next_token: '' },
}

const filters = (over: Partial<MediaFilters> = {}): MediaFilters => ({ ...EMPTY_MEDIA_FILTERS, ...over })

describe('media filter query params', () => {
  it('omits every filter param when nothing is set', async () => {
    mockFetch(200, EMPTY_CONTENTS)
    await getMediaFolder('col-1', { filters: EMPTY_MEDIA_FILTERS })
    expect(lastUrl()).toBe('/api/v1/folders/col-1/media')
  })

  it('sends date bounds as local-day start/end instants', async () => {
    mockFetch(200, EMPTY_CONTENTS)
    await getMediaFolder('col-1', { filters: filters({ takenAfter: '2024-03-04', takenBefore: '2024-03-06' }) })
    const params = query(lastUrl())

    // "After" anchors to local midnight, "before" to the last millisecond of
    // that local day — otherwise an evening photo would fall outside its own
    // date for anyone west of UTC.
    expect(new Date(params.get('taken_after')!).getTime())
      .toBe(new Date(2024, 2, 4, 0, 0, 0, 0).getTime())
    expect(new Date(params.get('taken_before')!).getTime())
      .toBe(new Date(2024, 2, 6, 23, 59, 59, 999).getTime())
  })

  it('sends upload date bounds independently of the taken bounds', async () => {
    mockFetch(200, EMPTY_CONTENTS)
    await getMediaFolder('col-1', { filters: filters({ uploadedAfter: '2023-01-01' }) })
    const params = query(lastUrl())
    expect(params.get('uploaded_after')).toBeTruthy()
    expect(params.get('taken_after')).toBeNull()
    expect(params.get('uploaded_before')).toBeNull()
  })

  it('ignores a malformed date rather than sending garbage', async () => {
    mockFetch(200, EMPTY_CONTENTS)
    await getMediaFolder('col-1', { filters: filters({ takenAfter: 'not-a-date' }) })
    expect(query(lastUrl()).get('taken_after')).toBeNull()
  })

  it('comma-joins sources, media types, and group ids', async () => {
    mockFetch(200, EMPTY_CONTENTS)
    await getMediaFolder('col-1', {
      filters: filters({
        sources: ['web', 'google_photos'],
        mediaTypes: ['image', 'video'],
        groupIds: ['g1', 'g2'],
      }),
    })
    const params = query(lastUrl())
    expect(params.get('source')).toBe('web,google_photos')
    expect(params.get('media_type')).toBe('image,video')
    expect(params.get('group')).toBe('g1,g2')
  })

  it('keeps sort and hidden alongside the filters', async () => {
    mockFetch(200, EMPTY_CONTENTS)
    await getMediaFolder('col-1', { sort: 'source', hidden: 'only', filters: filters({ mediaTypes: ['video'] }) })
    const params = query(lastUrl())
    expect(params.get('sort')).toBe('source')
    expect(params.get('hidden')).toBe('only')
    expect(params.get('media_type')).toBe('video')
  })
})

describe('getMediaFileIds', () => {
  it('hits the ids endpoint with the same filter params', async () => {
    mockFetch(200, { file_ids: ['a', 'b'], truncated: false })
    const res = await getMediaFileIds('col-1', { sort: 'name', filters: filters({ sources: ['device'] }) })

    const url = lastUrl()
    expect(url.startsWith('/api/v1/folders/col-1/media/ids?')).toBe(true)
    expect(query(url).get('source')).toBe('device')
    expect(query(url).get('sort')).toBe('name')
    expect(res.file_ids).toEqual(['a', 'b'])
    expect(res.truncated).toBe(false)
  })
})

describe('countMediaFilters', () => {
  it('counts nothing for the empty filter', () => {
    expect(countMediaFilters(EMPTY_MEDIA_FILTERS)).toBe(0)
  })

  it('counts each populated facet once', () => {
    expect(countMediaFilters(filters({ takenAfter: '2024-01-01', takenBefore: '2024-02-01' }))).toBe(2)
    expect(countMediaFilters(filters({ sources: ['web', 'device'] }))).toBe(1)
    expect(
      countMediaFilters(filters({ uploadedAfter: '2024-01-01', mediaTypes: ['image'], groupIds: ['g1'] })),
    ).toBe(3)
  })
})
