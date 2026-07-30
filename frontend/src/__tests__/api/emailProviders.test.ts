import {
  fetchProgressFor,
  listGmailMessages,
  type ProviderEmailItem,
} from '../../api/emailProviders'

// Gmail lists ids 100 at a time and resolves each id to metadata, so one
// "page" (200 messages) is two list calls plus 200 metadata calls.
function mockGmail(totalMessages: number) {
  let issued = 0
  global.fetch = jest.fn().mockImplementation((url: string) => {
    if (url.includes('/messages?maxResults=100')) {
      const n = Math.min(100, Math.max(0, totalMessages - issued))
      const messages = Array.from({ length: n }, (_, i) => ({ id: `m${issued + i}` }))
      issued += n
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({
          messages,
          nextPageToken: issued < totalMessages ? `tok-${issued}` : undefined,
        }),
      })
    }
    const id = url.split('/messages/')[1].split('?')[0]
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => ({
        id,
        snippet: '',
        internalDate: '1750000000000',
        labelIds: [],
        sizeEstimate: 1000,
        payload: { headers: [{ name: 'From', value: 'Jane <jane@x.com>' }] },
      }),
    })
  })
}

function item(overrides: Partial<ProviderEmailItem> = {}): ProviderEmailItem {
  return {
    id: 'x', provider: 'gmail', from: '', fromAddr: '', to: '', subject: '', snippet: '',
    date: new Date().toISOString(), starred: false, unread: false, hasAttachments: false,
    sizeEstimate: 0, ...overrides,
  }
}

describe('listGmailMessages streaming', () => {
  it('hands each page to onPage as it lands, trimmed to the criteria', async () => {
    mockGmail(1000)
    const pages: number[] = []

    const res = await listGmailMessages('token', { mode: 'amount', amount: 250 }, {
      onPage: (items) => pages.push(items.length),
    })

    // First page of 200, then the second trimmed down to the 250 asked for —
    // the picker never shows rows the run would drop.
    expect(pages).toEqual([200, 250])
    expect(res.items).toHaveLength(250)
    expect(res.truncated).toBe(false)
    expect(res.stopped).toBe(false)
  })

  it('reports fetch progress against the criteria', async () => {
    mockGmail(1000)
    const fractions: (number | null)[] = []

    await listGmailMessages('token', { mode: 'amount', amount: 400 }, {
      onPage: (_items, progress) => fractions.push(progress.fraction),
    })

    expect(fractions).toEqual([0.5, 1])
  })

  it('stops paging when the caller asks it to, keeping what arrived', async () => {
    mockGmail(1000)
    let pagesSeen = 0

    const res = await listGmailMessages('token', { mode: 'amount', amount: 1000 }, {
      onPage: () => { pagesSeen++ },
      shouldStop: () => pagesSeen >= 1,
    })

    expect(res.stopped).toBe(true)
    expect(res.items).toHaveLength(200)
  })
})

describe('fetchProgressFor', () => {
  it('measures a count against the requested amount', () => {
    const items = Array.from({ length: 50 }, () => item())
    expect(fetchProgressFor({ mode: 'amount', amount: 200 }, items))
      .toEqual({ fetched: 50, fraction: 0.25 })
  })

  it('measures accumulated bytes against a size target', () => {
    const items = Array.from({ length: 4 }, () => item({ sizeEstimate: 250 }))
    expect(fetchProgressFor({ mode: 'size', maxBytes: 2000 }, items))
      .toEqual({ fetched: 4, fraction: 0.5 })
  })

  it('measures how far back a date fetch has travelled', () => {
    const now = Date.now()
    const since = new Date(now - 10 * 86_400_000).toISOString().slice(0, 10)
    // Oldest fetched message is ~5 days back out of a ~10-day span.
    const items = [item({ date: new Date(now - 5 * 86_400_000).toISOString() })]
    const { fraction } = fetchProgressFor({ mode: 'date', sinceDate: since }, items)
    expect(fraction).toBeGreaterThan(0.4)
    expect(fraction).toBeLessThan(0.6)
  })

  it('reports no fraction when nothing has arrived yet', () => {
    expect(fetchProgressFor({ mode: 'date', sinceDate: '2026-01-01' }, []))
      .toEqual({ fetched: 0, fraction: null })
  })
})
