import { getMe, changePassword, meQueryOptions } from '../../api/me'

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

const MOCK_USER = {
  id: 'u1',
  username: 'alice',
  email: 'alice@example.com',
  role: 'user',
  storage_used_bytes: 0,
  storage_quota_bytes: 10 * 1024 ** 3,
}

describe('getMe', () => {
  it('GETs /me', async () => {
    mockFetch(200, MOCK_USER)
    const result = await getMe()
    const [url] = lastCall()
    expect(url).toBe('/api/v1/me')
    expect(result).toMatchObject({ username: 'alice' })
  })
})

describe('changePassword', () => {
  it('POSTs to /me/password with current and new password', async () => {
    mockFetch(200, { message: 'updated' })
    const result = await changePassword('oldpass', 'newpass')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/me/password')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      current_password: 'oldpass',
      new_password: 'newpass',
    })
    expect(result).toEqual({ message: 'updated' })
  })
})

describe('meQueryOptions', () => {
  it('has correct queryKey', () => {
    expect(meQueryOptions.queryKey).toEqual(['me'])
  })

  it('queryFn calls getMe', () => {
    mockFetch(200, MOCK_USER)
    meQueryOptions.queryFn()
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('/api/v1/me')
  })

  it('does not retry on failure', () => {
    expect(meQueryOptions.retry).toBe(false)
  })

  it('has a staleTime of 5 minutes', () => {
    expect(meQueryOptions.staleTime).toBe(5 * 60 * 1000)
  })

  it('has a refetchInterval of 4 minutes', () => {
    expect(meQueryOptions.refetchInterval).toBe(4 * 60 * 1000)
  })

  it('does not refetch in background', () => {
    expect(meQueryOptions.refetchIntervalInBackground).toBe(false)
  })
})
