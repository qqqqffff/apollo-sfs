import {
  listRegistrationGroups,
  createRegistrationGroup,
  getRegistrationGroup,
  deactivateRegistrationGroup,
  deleteRegistrationGroup,
  getRegistrationCapacity,
  getGroupInvite,
  reserveGroupSlot,
  getSlotReservation,
  releaseSlotReservation,
  checkEmail,
  registrationGroupsInfiniteQueryOptions,
} from '../../api/registrationGroups'

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

describe('admin registration group endpoints', () => {
  it('listRegistrationGroups GETs /admin/registration-groups', async () => {
    mockFetch(200, { items: [] })
    await listRegistrationGroups()
    expect(lastCall()[0]).toBe('/api/v1/admin/registration-groups')
  })

  it('listRegistrationGroups passes the cursor', async () => {
    mockFetch(200, { items: [] })
    await listRegistrationGroups('abc')
    expect(lastCall()[0]).toBe('/api/v1/admin/registration-groups?cursor=abc')
  })

  it('createRegistrationGroup POSTs the full body', async () => {
    mockFetch(201, { id: 'g1' })
    const body = {
      name: 'Robotics Club',
      expires_at: '2026-08-01T00:00:00.000Z',
      notify_emails: ['a@example.com'],
      send_expiry_reminder: true,
      slots: [{
        server_id: 's1',
        drive_type: 'nvme' as const,
        quota_bytes: 10 * 1024 ** 3,
        account_status: 'premium' as const,
        premium_expires_at: '2026-08-07T00:00:00.000Z',
        count: 3,
      }],
    }
    await createRegistrationGroup(body)
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/admin/registration-groups')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual(body)
  })

  it('getRegistrationGroup GETs the detail endpoint', async () => {
    mockFetch(200, { id: 'g1', slot_types: [] })
    await getRegistrationGroup('g1')
    expect(lastCall()[0]).toBe('/api/v1/admin/registration-groups/g1')
  })

  it('deactivateRegistrationGroup POSTs to /deactivate', async () => {
    mockFetch(200, { message: 'ok' })
    await deactivateRegistrationGroup('g1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/admin/registration-groups/g1/deactivate')
    expect(init.method).toBe('POST')
  })

  it('deleteRegistrationGroup DELETEs the group', async () => {
    mockFetch(200, { message: 'ok' })
    await deleteRegistrationGroup('g1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/admin/registration-groups/g1')
    expect(init.method).toBe('DELETE')
  })

  it('getRegistrationCapacity GETs the capacity endpoint', async () => {
    mockFetch(200, { tiers: [] })
    await getRegistrationCapacity()
    expect(lastCall()[0]).toBe('/api/v1/admin/registration-groups/capacity')
  })
})

describe('public group-invite endpoints', () => {
  it('getGroupInvite GETs the link id (encoded)', async () => {
    mockFetch(200, { name: 'g', link_id: 'club-a1b2', slot_types: [] })
    await getGroupInvite('club-a1b2')
    expect(lastCall()[0]).toBe('/api/v1/group-invites/club-a1b2')
  })

  it('reserveGroupSlot POSTs the slot id', async () => {
    mockFetch(201, { reservation_token: 't', expires_at: '2026-01-01T00:00:00Z' })
    await reserveGroupSlot('club-a1b2', 'slot-1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/group-invites/club-a1b2/reservations')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ slot_id: 'slot-1' })
  })

  it('getSlotReservation GETs the reservation by token', async () => {
    mockFetch(200, { status: 'active' })
    await getSlotReservation('tok-1')
    expect(lastCall()[0]).toBe('/api/v1/group-invites/reservations/tok-1')
  })

  it('releaseSlotReservation DELETEs the reservation', async () => {
    mockFetch(200, { message: 'released' })
    await releaseSlotReservation('tok-1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/group-invites/reservations/tok-1')
    expect(init.method).toBe('DELETE')
  })

  it('checkEmail POSTs the email to /auth/check-email', async () => {
    mockFetch(200, { valid: true, available: false })
    const result = await checkEmail('a@example.com')
    const [url, init] = lastCall()
    expect(url).toBe('/api/v1/auth/check-email')
    expect(JSON.parse(init.body as string)).toEqual({ email: 'a@example.com' })
    expect(result).toEqual({ valid: true, available: false })
  })
})

describe('registrationGroupsInfiniteQueryOptions', () => {
  it('has the admin registration-groups queryKey', () => {
    expect(registrationGroupsInfiniteQueryOptions.queryKey).toEqual(['admin', 'registration-groups'])
  })

  it('getNextPageParam returns next_token or undefined', () => {
    expect(registrationGroupsInfiniteQueryOptions.getNextPageParam({ items: [], next_token: 'n' })).toBe('n')
    expect(registrationGroupsInfiniteQueryOptions.getNextPageParam({ items: [] })).toBeUndefined()
  })
})
