import {
  getPublicConfig,
  submitInterestForm,
  publicConfigQueryOptions,
} from '../../api/interest'

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

describe('getPublicConfig', () => {
  it('GETs /config', async () => {
    mockFetch(200, { turnstile_site_key: 'key-abc' })
    const result = await getPublicConfig()
    const [url] = lastCall()
    expect(url).toBe('/api/v1/config')
    expect(result).toEqual({ turnstile_site_key: 'key-abc' })
  })
})

describe('submitInterestForm', () => {
  it('POSTs to /interest with all payload fields', async () => {
    mockFetch(200, { message: 'submitted' })
    const payload = {
      name: 'Alice',
      email: 'alice@example.com',
      desired_storage_gb: 100,
      use_case: 'backup',
      captcha_token: 'cf-token',
    }
    const result = await submitInterestForm(payload)
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/interest')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual(payload)
    expect(result).toEqual({ message: 'submitted' })
  })
})

describe('publicConfigQueryOptions', () => {
  it('has correct queryKey', () => {
    expect(publicConfigQueryOptions.queryKey).toEqual(['public', 'config'])
  })

  it('queryFn calls getPublicConfig', () => {
    mockFetch(200, { turnstile_site_key: 'key' })
    publicConfigQueryOptions.queryFn()
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('/api/v1/config')
  })

  it('has staleTime of Infinity', () => {
    expect(publicConfigQueryOptions.staleTime).toBe(Infinity)
  })
})
