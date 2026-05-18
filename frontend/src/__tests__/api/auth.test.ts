import { login, register, logout, refresh, forgotPassword, resetPassword, validateInviteToken } from '../../api/auth'

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

describe('login', () => {
  it('POSTs to /api/v1/auth/login with credentials', async () => {
    mockFetch(200, { username: 'alice' })
    const result = await login('alice', 'secret')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/auth/login')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ username: 'alice', password: 'secret' })
    expect(result).toEqual({ username: 'alice' })
  })
})

describe('register', () => {
  it('POSTs to /api/v1/auth/register with all fields', async () => {
    mockFetch(201, { username: 'bob' })
    await register('bob', 'bob@example.com', 'pass123', 'tok-abc')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/auth/register')
    expect(JSON.parse(init.body as string)).toEqual({
      username: 'bob',
      email: 'bob@example.com',
      password: 'pass123',
      invite_token: 'tok-abc',
    })
  })
})

describe('logout', () => {
  it('POSTs to /api/v1/auth/logout with no body', async () => {
    mockFetch(204, undefined)
    const res = { ok: true, status: 204, statusText: 'No Content', json: jest.fn() }
    global.fetch = jest.fn().mockResolvedValue(res)
    await logout()
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/auth/logout')
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
  })
})

describe('refresh', () => {
  it('POSTs to /api/v1/auth/refresh', async () => {
    const res = { ok: true, status: 204, statusText: 'No Content', json: jest.fn() }
    global.fetch = jest.fn().mockResolvedValue(res)
    await refresh()
    const [url] = lastCall()
    expect(url).toBe('/api/v1/auth/refresh')
  })
})

describe('forgotPassword', () => {
  it('POSTs to /api/v1/auth/forgot_password with email', async () => {
    mockFetch(200, { message: 'sent' })
    const result = await forgotPassword('user@example.com')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/auth/forgot_password')
    expect(JSON.parse(init.body as string)).toEqual({ email: 'user@example.com' })
    expect(result).toEqual({ message: 'sent' })
  })
})

describe('resetPassword', () => {
  it('POSTs to /api/v1/auth/reset_password with token and new password', async () => {
    mockFetch(200, { message: 'reset' })
    await resetPassword('reset-tok', 'newpass')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/auth/reset_password')
    expect(JSON.parse(init.body as string)).toEqual({ token: 'reset-tok', new_password: 'newpass' })
  })
})

describe('validateInviteToken', () => {
  it('GETs /api/v1/invitations/:token', async () => {
    mockFetch(200, { valid: true })
    const result = await validateInviteToken('inv-123')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/invitations/inv-123')
    expect(init?.method).toBeUndefined()
    expect(result).toEqual({ valid: true })
  })

  it('returns valid:false for invalid token', async () => {
    mockFetch(200, { valid: false })
    const result = await validateInviteToken('bad-tok')
    expect(result).toEqual({ valid: false })
  })
})
