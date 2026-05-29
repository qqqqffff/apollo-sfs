import {
  listUsers,
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
  createServer,
  updateServer,
  addDrive,
  updateDrive,
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
  getAlarmSettings,
  toggleAlarmSubscription,
  alarmSettingsQueryOptions,
  getDriveTemps,
  driveTempsQueryOptions,
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
    expect(lastBody()).toEqual({ email: 'bob@example.com', initial_quota_bytes: 5 * 1024 ** 3, grant_admin: false })
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

describe('createServer', () => {
  it('POSTs to /admin/system/servers', async () => {
    mockFetch(200, { id: 'srv-1', name: 'NH-1' })
    await createServer({
      state: 'NH',
      minio_endpoint: 'minio:9000',
      minio_use_ssl: false,
      access_key: 'key',
      secret_key: 'secret',
    })
    expect(lastUrl()).toBe('/api/v1/admin/system/servers')
    expect(lastInit().method).toBe('POST')
    expect(lastBody()).toMatchObject({ state: 'NH', minio_use_ssl: false })
  })
})

describe('updateServer', () => {
  it('PATCHes /admin/system/servers/:id', async () => {
    mockFetch(200, { message: 'updated' })
    await updateServer('srv-1', { is_active: false })
    expect(lastUrl()).toBe('/api/v1/admin/system/servers/srv-1')
    expect(lastInit().method).toBe('PATCH')
    expect(lastBody()).toEqual({ is_active: false })
  })
})

describe('addDrive', () => {
  it('POSTs to /admin/system/servers/:id/drives', async () => {
    mockFetch(200, { drive_id: 'd1' })
    await addDrive('srv-1', { label: 'nvme-02', minio_bucket: 'bucket2', capacity_bytes: 2000 })
    expect(lastUrl()).toBe('/api/v1/admin/system/servers/srv-1/drives')
    expect(lastInit().method).toBe('POST')
    expect(lastBody()).toEqual({ label: 'nvme-02', minio_bucket: 'bucket2', capacity_bytes: 2000 })
  })
})

describe('updateDrive', () => {
  it('PATCHes /admin/system/servers/:id/drives/:driveId', async () => {
    mockFetch(200, { drive_id: 'd1' })
    await updateDrive('srv-1', 'd1', { is_active: false })
    expect(lastUrl()).toBe('/api/v1/admin/system/servers/srv-1/drives/d1')
    expect(lastInit().method).toBe('PATCH')
    expect(lastBody()).toEqual({ is_active: false })
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

// ── Alarm settings ─────────────────────────────────────────────────────────────

const ALARM_DEFAULTS = {
  cpu_usage_emails: [] as string[],
  cpu_usage_last_fired_at: null,
  cpu_temp_emails: [] as string[],
  cpu_temp_last_fired_at: null,
  drive_temp_emails: [] as string[],
  drive_temp_last_fired_at: null,
  drive_load_emails: [] as string[],
  drive_load_last_fired_at: null,
  network_traffic_emails: [] as string[],
  network_traffic_last_fired_at: null,
  api_error_rate_emails: [] as string[],
  api_error_rate_last_fired_at: null,
  updated_at: '2026-01-01T00:00:00Z',
}

describe('getAlarmSettings', () => {
  it('GETs /admin/system/alarm/settings', async () => {
    mockFetch(200, ALARM_DEFAULTS)
    const result = await getAlarmSettings()
    expect(lastUrl()).toBe('/api/v1/admin/system/alarm/settings')
    expect(lastInit().method).toBeUndefined()
    expect(result).toEqual(ALARM_DEFAULTS)
  })
})

describe('toggleAlarmSubscription', () => {
  it('POSTs /admin/system/alarm/subscribe with subscribe=true', async () => {
    mockFetch(200, ALARM_DEFAULTS)
    await toggleAlarmSubscription('cpu_usage', true)
    expect(lastUrl()).toBe('/api/v1/admin/system/alarm/subscribe')
    expect(lastInit().method).toBe('POST')
    expect(lastBody()).toEqual({ alarm_type: 'cpu_usage', subscribed: true })
  })

  it('POSTs /admin/system/alarm/subscribe with subscribe=false', async () => {
    mockFetch(200, ALARM_DEFAULTS)
    await toggleAlarmSubscription('cpu_temp', false)
    expect(lastBody()).toEqual({ alarm_type: 'cpu_temp', subscribed: false })
  })

  it('sends correct alarm_type for each type', async () => {
    const types = [
      'cpu_usage', 'cpu_temp', 'drive_temp',
      'drive_load', 'network_traffic', 'api_error_rate',
    ] as const
    for (const t of types) {
      mockFetch(200, ALARM_DEFAULTS)
      await toggleAlarmSubscription(t, true)
      expect(lastBody().alarm_type).toBe(t)
    }
  })
})

describe('alarmSettingsQueryOptions', () => {
  it('has correct queryKey', () => {
    expect(alarmSettingsQueryOptions.queryKey).toEqual(['admin', 'alarm', 'settings'])
  })

  it('queryFn calls getAlarmSettings', () => {
    mockFetch(200, ALARM_DEFAULTS)
    alarmSettingsQueryOptions.queryFn()
    expect(lastUrl()).toBe('/api/v1/admin/system/alarm/settings')
  })
})

// ── Drive temperatures ─────────────────────────────────────────────────────────

const DRIVE_TEMPS = [
  { name: 'nvme-pci-0100 Composite', temp_celsius: 38.5 },
  { name: 'nvme-pci-0200 Composite', temp_celsius: 52.0 },
]

describe('getDriveTemps', () => {
  it('GETs /admin/system/drive-temps', async () => {
    mockFetch(200, DRIVE_TEMPS)
    await getDriveTemps()
    expect(lastUrl()).toBe('/api/v1/admin/system/drive-temps')
    expect(lastInit().method).toBeUndefined()
  })

  it('returns the array of drive temps', async () => {
    mockFetch(200, DRIVE_TEMPS)
    const result = await getDriveTemps()
    expect(result).toEqual(DRIVE_TEMPS)
  })

  it('returns an empty array when no sensors are available', async () => {
    mockFetch(200, [])
    const result = await getDriveTemps()
    expect(result).toEqual([])
  })
})

describe('driveTempsQueryOptions', () => {
  it('has correct queryKey', () => {
    expect(driveTempsQueryOptions.queryKey).toEqual(['admin', 'drive-temps'])
  })

  it('has staleTime of 10 seconds', () => {
    expect(driveTempsQueryOptions.staleTime).toBe(10_000)
  })

  it('has refetchInterval of 10 seconds', () => {
    expect(driveTempsQueryOptions.refetchInterval).toBe(10_000)
  })

  it('queryFn calls getDriveTemps', () => {
    mockFetch(200, DRIVE_TEMPS)
    driveTempsQueryOptions.queryFn()
    expect(lastUrl()).toBe('/api/v1/admin/system/drive-temps')
  })
})
