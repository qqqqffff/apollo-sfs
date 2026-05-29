import {
  listEmailWorkers,
  listEmails,
  getEmail,
  markEmailRead,
  deleteEmail,
  emailWorkersQueryOptions,
  emailsInfiniteQueryOptions,
} from '../../api/inboundEmails'
import type { EmailMeta } from '../../types/inboundEmail'
import type { PageResult } from '../../types/api'

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
function lastUrl() { return lastCall()[0] }
function lastInit() { return lastCall()[1] }
function lastBody() { return JSON.parse(lastInit().body as string) }

describe('listEmailWorkers', () => {
  it('GETs /admin/emails/workers', async () => {
    mockFetch(200, { workers: [] })
    await listEmailWorkers()
    expect(lastUrl()).toBe('/api/v1/admin/emails/workers')
  })
})

describe('listEmails', () => {
  it('GETs /admin/emails with no params', async () => {
    mockFetch(200, { items: [], next_token: '' })
    await listEmails()
    expect(lastUrl()).toBe('/api/v1/admin/emails')
  })

  it('appends worker', async () => {
    mockFetch(200, { items: [], next_token: '' })
    await listEmails('support')
    expect(lastUrl()).toBe('/api/v1/admin/emails?worker=support')
  })

  it('appends worker, cursor and limit', async () => {
    mockFetch(200, { items: [], next_token: '' })
    await listEmails('support', 'cur-1', 25)
    expect(lastUrl()).toBe('/api/v1/admin/emails?worker=support&cursor=cur-1&limit=25')
  })
})

describe('getEmail', () => {
  it('GETs /admin/emails/:id', async () => {
    mockFetch(200, { id: 'e1' })
    await getEmail('e1')
    expect(lastUrl()).toBe('/api/v1/admin/emails/e1')
  })
})

describe('markEmailRead', () => {
  it('PATCHes /admin/emails/:id/read', async () => {
    mockFetch(200, { message: 'ok' })
    await markEmailRead('e1')
    expect(lastUrl()).toBe('/api/v1/admin/emails/e1/read')
    expect(lastInit().method).toBe('PATCH')
    expect(lastBody()).toEqual({})
  })
})

describe('deleteEmail', () => {
  it('DELETEs /admin/emails/:id', async () => {
    mockFetch(200, { message: 'deleted' })
    await deleteEmail('e1')
    expect(lastUrl()).toBe('/api/v1/admin/emails/e1')
    expect(lastInit().method).toBe('DELETE')
  })
})

describe('emailWorkersQueryOptions', () => {
  it('is keyed under admin/emails/workers', () => {
    expect(emailWorkersQueryOptions.queryKey).toEqual(['admin', 'emails', 'workers'])
  })
})

describe('emailsInfiniteQueryOptions', () => {
  it('keys by worker (all when omitted)', () => {
    expect(emailsInfiniteQueryOptions().queryKey).toEqual(['admin', 'emails', 'list', 'all'])
    expect(emailsInfiniteQueryOptions('support').queryKey).toEqual(['admin', 'emails', 'list', 'support'])
  })

  it('derives next page param from next_token', () => {
    const opts = emailsInfiniteQueryOptions()
    const page: PageResult<EmailMeta> = { items: [], next_token: 'tok-2' }
    expect(opts.getNextPageParam(page)).toBe('tok-2')
    expect(opts.getNextPageParam({ items: [], next_token: '' })).toBeUndefined()
  })
})
