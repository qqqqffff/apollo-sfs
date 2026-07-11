import {
  listUsers,
  searchAdminUsers,
  updateUserStorageAllocations,
  getUser,
  updateUserQuota,
  updateUsername,
  listInvitations,
  createInvitation,
  revokeInvitation,
  resendInvitation,
  getMetrics,
  getMetricsHistoryByHours,
  pingServer,
  listInfrastructure,
  getCapacity,
  syncInfrastructure,
  listBannedIPs,
  unbanIP,
  extendBan,
  listInterestSubmissions,
  getInterestFormSettings,
  updateInterestFormSettings,
  provisionInterestSubmission,
  getSpeedTest,
  triggerSpeedTest,
  runTests,
  shutdownServer,
  infrastructureQueryOptions,
  capacityQueryOptions,
  speedTestQueryOptions,
  adminInterestInfiniteQueryOptions,
  interestFormSettingsQueryOptions,
  getAlarmSubscriptions,
  upsertAlarmSubscription,
  deleteAlarmSubscription,
  alarmSubscriptionsQueryOptions,
} from '../../api/admin'
import type { InterestSubmission, PageResult } from '../../types/api'

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: jest.fn().mockResolvedValue(body),
  })
}

function mock204() {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 204,
    statusText: 'No Content',
    json: jest.fn(),
  })
}

function lastCall() {
  return (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
}

function lastUrl() { return lastCall()[0] }
function lastInit() { return lastCall()[1] }
function lastBody() { return JSON.parse(lastInit().body as string) }

// ── Users ─────────────────────────────────────────────────────────────────────

describe('listUsers', () => {
  it('GETs /admin/users with no params', async () => {
    mockFetch(200, { items: [], next_token: '' })
    await listUsers()
    expect(lastUrl()).toBe('/api/v1/admin/users')
  })

  it('appends cursor and limit', async () => {
    mockFetch(200, { items: [], next_token: '' })
    await listUsers('curs-1', 25)
    expect(lastUrl()).toBe('/api/v1/admin/users?cursor=curs-1&limit=25')
  })
})

describe('searchAdminUsers', () => {
  it('GETs /admin/users/search with no params', async () => {
    mockFetch(200, { items: [], total: 0, page: 1, page_size: 25 })
    await searchAdminUsers()
    expect(lastUrl()).toBe('/api/v1/admin/users/search')
  })

  it('appends search, role, sort, dir, page, page_size', async () => {
    mockFetch(200, { items: [], total: 0, page: 2, page_size: 25 })
    await searchAdminUsers({ search: 'ali', role: 'admin', sort: 'username', dir: 'asc', page: 2, page_size: 25 })
    expect(lastUrl()).toBe('/api/v1/admin/users/search?search=ali&role=admin&sort=username&dir=asc&page=2&page_size=25')
  })
})

describe('getUser', () => {
  it('GETs /admin/users/:username', async () => {
    mockFetch(200, { id: 'u1', username: 'alice' })
    await getUser('alice')
    expect(lastUrl()).toBe('/api/v1/admin/users/alice')
  })
})

describe('updateUserQuota', () => {
  it('PATCHes /admin/users/:username/quota', async () => {
    mockFetch(200, { message: 'updated' })
    await updateUserQuota('alice', 10 * 1024 ** 3)
    expect(lastUrl()).toBe('/api/v1/admin/users/alice/quota')
    expect(lastInit().method).toBe('PATCH')
    expect(lastBody()).toEqual({ quota_bytes: 10 * 1024 ** 3 })
  })
})

describe('updateUserStorageAllocations', () => {
  it('PUTs /admin/users/:username/storage/allocations', async () => {
    mockFetch(200, { quota_bytes: 0, used_bytes: 0, nvme_bytes: 0, hdd_bytes: 0, allocations: [], active_request_count: 0 })
    await updateUserStorageAllocations('alice', {
      allocations: [{ drive_id: 'd1', quota_bytes: 10 * 1024 ** 3 }],
      reason: 'growing them a bit',
    })
    expect(lastUrl()).toBe('/api/v1/admin/users/alice/storage/allocations')
    expect(lastInit().method).toBe('PUT')
    expect(lastBody()).toEqual({
      allocations: [{ drive_id: 'd1', quota_bytes: 10 * 1024 ** 3 }],
      reason: 'growing them a bit',
    })
  })
})

describe('updateUsername', () => {
  it('PATCHes /admin/users/:username/username', async () => {
    mockFetch(200, { message: 'updated' })
    await updateUsername('alice', 'alice2')
    expect(lastUrl()).toBe('/api/v1/admin/users/alice/username')
    expect(lastBody()).toEqual({ new_username: 'alice2' })
  })
})

// ── Invitations ───────────────────────────────────────────────────────────────

describe('listInvitations', () => {
  it('GETs /admin/invitations with no params', async () => {
    mockFetch(200, { items: [], next_token: '' })
    await listInvitations()
    expect(lastUrl()).toBe('/api/v1/admin/invitations')
  })

  it('appends cursor', async () => {
    mockFetch(200, { items: [], next_token: '' })
    await listInvitations('tok-1')
    expect(lastUrl()).toBe('/api/v1/admin/invitations?cursor=tok-1')
  })
})

describe('createInvitation', () => {
  it('POSTs to /admin/invitations', async () => {
    mockFetch(200, { id: 'inv-1', email: 'bob@example.com' })
    await createInvitation('bob@example.com', 5 * 1024 ** 3)
    expect(lastUrl()).toBe('/api/v1/admin/invitations')
    expect(lastInit().method).toBe('POST')
    expect(lastBody()).toEqual({ email: 'bob@example.com', initial_quota_bytes: 5 * 1024 ** 3, grant_admin: false, grant_premium: false })
  })
})

describe('revokeInvitation', () => {
  it('DELETEs /admin/invitations/:id', async () => {
    mockFetch(200, { message: 'revoked' })
    await revokeInvitation('inv-1')
    expect(lastUrl()).toBe('/api/v1/admin/invitations/inv-1')
    expect(lastInit().method).toBe('DELETE')
  })
})

describe('resendInvitation', () => {
  it('POSTs to /admin/invitations/:id/resend', async () => {
    mockFetch(200, { message: 'resent' })
    await resendInvitation('inv-1')
    expect(lastUrl()).toBe('/api/v1/admin/invitations/inv-1/resend')
    expect(lastInit().method).toBe('POST')
  })
})

// ── Metrics ───────────────────────────────────────────────────────────────────

describe('getMetrics', () => {
  it('GETs /admin/system/metrics', async () => {
    mockFetch(200, { cpu_percent: 12 })
    await getMetrics()
    expect(lastUrl()).toBe('/api/v1/admin/system/metrics')
  })
})

describe('getMetricsHistoryByHours', () => {
  it('GETs /admin/system/metrics/history?hours=N', async () => {
    mockFetch(200, [])
    await getMetricsHistoryByHours(24)
    expect(lastUrl()).toBe('/api/v1/admin/system/metrics/history?hours=24')
  })
})

describe('pingServer', () => {
  beforeEach(() => {
    jest.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(25)
  })
  afterEach(() => jest.restoreAllMocks())

  it('GETs /api/v1/admin/system/ping', async () => {
    mock204()
    await pingServer()
    expect(lastUrl()).toBe('/api/v1/admin/system/ping')
  })

  it('returns the measured round-trip time in milliseconds', async () => {
    mock204()
    const rtt = await pingServer()
    expect(rtt).toBe(25)
  })

  it('uses a 5-second AbortSignal timeout', async () => {
    mock204()
    await pingServer()
    const signal = lastInit().signal as AbortSignal
    expect(signal).toBeDefined()
  })
})

// ── Infrastructure ────────────────────────────────────────────────────────────

describe('listInfrastructure', () => {
  it('GETs /admin/system/infrastructure', async () => {
    mockFetch(200, { drives: [] })
    await listInfrastructure()
    expect(lastUrl()).toBe('/api/v1/admin/system/infrastructure')
  })
})

describe('getCapacity', () => {
  it('GETs /admin/system/capacity', async () => {
    mockFetch(200, { max_available_bytes: 0 })
    await getCapacity()
    expect(lastUrl()).toBe('/api/v1/admin/system/capacity')
  })
})

describe('syncInfrastructure', () => {
  it('POSTs to /admin/system/sync and returns the summary', async () => {
    mockFetch(200, { servers: 2, nodes: 2, drives: 2, pruned: 0 })
    const summary = await syncInfrastructure()
    expect(lastUrl()).toBe('/api/v1/admin/system/sync')
    expect(lastInit().method).toBe('POST')
    expect(summary).toEqual({ servers: 2, nodes: 2, drives: 2, pruned: 0 })
  })
})

// ── Banned IPs ────────────────────────────────────────────────────────────────

describe('listBannedIPs', () => {
  it('GETs /admin/banned-ips with status param', async () => {
    mockFetch(200, { items: [], next_token: '' })
    await listBannedIPs('active')
    expect(lastUrl()).toBe('/api/v1/admin/banned-ips?status=active')
  })

  it('appends cursor and limit', async () => {
    mockFetch(200, { items: [], next_token: '' })
    await listBannedIPs('all', 'curs-1', 50)
    expect(lastUrl()).toBe('/api/v1/admin/banned-ips?status=all&cursor=curs-1&limit=50')
  })
})

describe('unbanIP', () => {
  it('POSTs to /admin/banned-ips/:id/unban', async () => {
    mockFetch(200, { message: 'unbanned' })
    await unbanIP(42)
    expect(lastUrl()).toBe('/api/v1/admin/banned-ips/42/unban')
    expect(lastInit().method).toBe('POST')
  })
})

describe('extendBan', () => {
  it('POSTs to /admin/banned-ips/:id/extend', async () => {
    mockFetch(200, { message: 'extended' })
    await extendBan(42)
    expect(lastUrl()).toBe('/api/v1/admin/banned-ips/42/extend')
    expect(lastInit().method).toBe('POST')
  })
})

// ── Interest form ─────────────────────────────────────────────────────────────

describe('listInterestSubmissions', () => {
  it('GETs /admin/interest with no params', async () => {
    mockFetch(200, { items: [], next_token: '' })
    await listInterestSubmissions()
    expect(lastUrl()).toBe('/api/v1/admin/interest')
  })

  it('appends cursor', async () => {
    mockFetch(200, { items: [], next_token: '' })
    await listInterestSubmissions('curs-1')
    expect(lastUrl()).toBe('/api/v1/admin/interest?cursor=curs-1')
  })
})

describe('getInterestFormSettings', () => {
  it('GETs /admin/interest/settings', async () => {
    mockFetch(200, { daily_cap: 10 })
    const result = await getInterestFormSettings()
    expect(lastUrl()).toBe('/api/v1/admin/interest/settings')
    expect(result).toEqual({ daily_cap: 10 })
  })
})

describe('updateInterestFormSettings', () => {
  it('PUTs /admin/interest/settings with daily_cap', async () => {
    mockFetch(200, { daily_cap: 20 })
    await updateInterestFormSettings(20)
    expect(lastUrl()).toBe('/api/v1/admin/interest/settings')
    expect(lastInit().method).toBe('PUT')
    expect(lastBody()).toEqual({ daily_cap: 20 })
  })
})

describe('provisionInterestSubmission', () => {
  it('POSTs to /admin/interest/:id/provision', async () => {
    mockFetch(200, { id: 'inv-1' })
    await provisionInterestSubmission('sub-1', 10 * 1024 ** 3)
    expect(lastUrl()).toBe('/api/v1/admin/interest/sub-1/provision')
    expect(lastInit().method).toBe('POST')
    expect(lastBody()).toEqual({ initial_quota_bytes: 10 * 1024 ** 3, grant_admin: false })
  })
})

describe('adminInterestInfiniteQueryOptions', () => {
  it('has correct queryKey', () => {
    expect(adminInterestInfiniteQueryOptions.queryKey).toEqual(['admin', 'interest'])
  })

  it('queryFn calls listInterestSubmissions with pageParam', () => {
    mockFetch(200, { items: [], next_token: '' })
    adminInterestInfiniteQueryOptions.queryFn({ pageParam: 'curs-1' })
    expect(lastUrl()).toBe('/api/v1/admin/interest?cursor=curs-1')
  })

  it('getNextPageParam returns next_token when present', () => {
    const page: PageResult<InterestSubmission> = {
      items: [],
      next_token: 'tok-next',
    }
    expect(adminInterestInfiniteQueryOptions.getNextPageParam(page)).toBe('tok-next')
  })

  it('getNextPageParam returns undefined when next_token is empty', () => {
    const page: PageResult<InterestSubmission> = { items: [], next_token: '' }
    expect(adminInterestInfiniteQueryOptions.getNextPageParam(page)).toBeUndefined()
  })
})

describe('interestFormSettingsQueryOptions', () => {
  it('has correct queryKey', () => {
    expect(interestFormSettingsQueryOptions.queryKey).toEqual(['admin', 'interest', 'settings'])
  })

  it('queryFn calls getInterestFormSettings', () => {
    mockFetch(200, { daily_cap: 5 })
    interestFormSettingsQueryOptions.queryFn()
    expect(lastUrl()).toBe('/api/v1/admin/interest/settings')
  })
})

// ── Speed test ────────────────────────────────────────────────────────────────

describe('getSpeedTest', () => {
  it('GETs /admin/system/speed-test', async () => {
    mockFetch(200, { upload_mbps: 100, download_mbps: 200 })
    await getSpeedTest()
    expect(lastUrl()).toBe('/api/v1/admin/system/speed-test')
  })
})

describe('triggerSpeedTest', () => {
  it('POSTs to /admin/system/speed-test', async () => {
    mockFetch(200, { upload_mbps: 90, download_mbps: 180 })
    await triggerSpeedTest()
    expect(lastUrl()).toBe('/api/v1/admin/system/speed-test')
    expect(lastInit().method).toBe('POST')
  })
})

describe('speedTestQueryOptions', () => {
  it('has correct queryKey', () => {
    expect(speedTestQueryOptions.queryKey).toEqual(['admin', 'speed-test'])
  })

  it('queryFn calls getSpeedTest', () => {
    mockFetch(200, { upload_mbps: 50 })
    speedTestQueryOptions.queryFn()
    expect(lastUrl()).toBe('/api/v1/admin/system/speed-test')
  })
})

// ── Infrastructure query options ───────────────────────────────────────────────

describe('infrastructureQueryOptions', () => {
  it('has correct queryKey', () => {
    expect(infrastructureQueryOptions.queryKey).toEqual(['admin', 'infrastructure'])
  })

  it('queryFn calls listInfrastructure', () => {
    mockFetch(200, { drives: [] })
    infrastructureQueryOptions.queryFn()
    expect(lastUrl()).toBe('/api/v1/admin/system/infrastructure')
  })

  it('has a refetchInterval', () => {
    expect(infrastructureQueryOptions.refetchInterval).toBeGreaterThan(0)
  })
})

describe('capacityQueryOptions', () => {
  it('has correct queryKey', () => {
    expect(capacityQueryOptions.queryKey).toEqual(['admin', 'capacity'])
  })

  it('queryFn calls getCapacity', () => {
    mockFetch(200, { max_available_bytes: 0 })
    capacityQueryOptions.queryFn()
    expect(lastUrl()).toBe('/api/v1/admin/system/capacity')
  })
})

// ── Tests runner / kill switch ─────────────────────────────────────────────────

describe('runTests', () => {
  it('POSTs to /admin/system/tests', async () => {
    mockFetch(200, {
      backend: { enabled: true, result: { passed: true, exit_code: 0, output: '', duration_ms: 100 } },
      frontend: { enabled: false, message: 'disabled' },
      frontend_e2e: { enabled: false, message: 'disabled' },
    })
    const result = await runTests()
    expect(lastUrl()).toBe('/api/v1/admin/system/tests')
    expect(lastInit().method).toBe('POST')
    expect(result.backend.enabled).toBe(true)
    expect(result.frontend_e2e.enabled).toBe(false)
  })
})

describe('shutdownServer', () => {
  it('POSTs to /admin/system/shutdown', async () => {
    mock204()
    await shutdownServer()
    expect(lastUrl()).toBe('/api/v1/admin/system/shutdown')
    expect(lastInit().method).toBe('POST')
  })
})

// ── Alarm subscriptions ────────────────────────────────────────────────────────

describe('getAlarmSubscriptions', () => {
  it('GETs /admin/system/alarm/subscriptions for the current user', async () => {
    mockFetch(200, [])
    await getAlarmSubscriptions()
    expect(lastUrl()).toBe('/api/v1/admin/system/alarm/subscriptions')
    expect(lastInit().method).toBeUndefined()
  })

  it('appends ?username when reviewing another user', async () => {
    mockFetch(200, [])
    await getAlarmSubscriptions('alice')
    expect(lastUrl()).toBe('/api/v1/admin/system/alarm/subscriptions?username=alice')
  })
})

describe('upsertAlarmSubscription', () => {
  it('PUTs the subscription target and threshold', async () => {
    mockFetch(200, {})
    await upsertAlarmSubscription({ alarm_type: 'cpu_usage', node_id: 'n1', threshold: 85 })
    expect(lastUrl()).toBe('/api/v1/admin/system/alarm/subscriptions')
    expect(lastInit().method).toBe('PUT')
    expect(lastBody()).toEqual({ alarm_type: 'cpu_usage', node_id: 'n1', threshold: 85 })
  })
})

describe('deleteAlarmSubscription', () => {
  it('DELETEs with the target body', async () => {
    mockFetch(200, { ok: true })
    await deleteAlarmSubscription({ alarm_type: 'api_error_rate' })
    expect(lastUrl()).toBe('/api/v1/admin/system/alarm/subscriptions')
    expect(lastInit().method).toBe('DELETE')
    expect(lastBody()).toEqual({ alarm_type: 'api_error_rate' })
  })
})

describe('alarmSubscriptionsQueryOptions', () => {
  it('keys by the target user (self by default)', () => {
    expect(alarmSubscriptionsQueryOptions().queryKey).toEqual(['admin', 'alarm', 'subscriptions', 'self'])
    expect(alarmSubscriptionsQueryOptions('alice').queryKey).toEqual(['admin', 'alarm', 'subscriptions', 'alice'])
  })

  it('queryFn fetches subscriptions', () => {
    mockFetch(200, [])
    alarmSubscriptionsQueryOptions().queryFn()
    expect(lastUrl()).toBe('/api/v1/admin/system/alarm/subscriptions')
  })
})
