import { test, expect } from '@playwright/test'
import {
  mockAuth,
  mockAdminUsers,
  mockAdminInvitations,
  mockAdminInterest,
  mockAdminBannedIPs,
  mockCapacity,
  mockInfrastructure,
  MOCK_ADMIN_USER,
  GB,
} from './fixtures'

const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()

const USERS = [
  { username: 'alice', email: 'alice@example.com', storage_used_bytes: 1 * GB, storage_quota_bytes: 10 * GB, is_admin: false, last_seen_at: null, created_at: '2024-01-01T00:00:00Z' },
  { username: 'bob',   email: 'bob@example.com',   storage_used_bytes: 2 * GB, storage_quota_bytes: 20 * GB, is_admin: true,  last_seen_at: null, created_at: '2024-01-02T00:00:00Z' },
]

const INVITATIONS = [
  { id: 'inv1', email: 'carol@example.com', initial_quota_bytes: 10 * GB, token_expires_at: FUTURE, accepted_at: null, revoked_at: null, invitation_url: 'https://example.com/invite/inv1' },
]

const SUBMISSIONS = [
  { id: 's1', name: 'Dave', email: 'dave@example.com', desired_storage_gb: 20, use_case: 'Research', ip_address: '1.2.3.4', created_at: '2024-01-01T00:00:00Z', provisioned_at: null, invitation_id: null },
]

const BANS = [
  { id: 1, ip: '1.2.3.4', country: 'US', city: 'New York', banned_at: new Date(Date.now() - 3600_000).toISOString(), unbanned_at: null, ban_count: 1, jail: 'nginx-api-scan' },
]

test.describe('Admin — Users page (/admin/users)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuth(page, MOCK_ADMIN_USER)
    await mockAdminUsers(page, USERS)
    await mockInfrastructure(page)
  })

  test('renders user rows from GET /api/v1/admin/users', async ({ page }) => {
    await page.goto('/admin/users')
    // Use role-based selectors to avoid strict-mode collisions with email cells
    await expect(page.getByRole('cell', { name: 'alice', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'alice@example.com', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'bob', exact: true })).toBeVisible()
  })

  // Per-user quota now lives in the expandable storage-details panel (one row
  // per drive allocation), not a flat column — see StorageDetails in
  // routes/_auth.admin/users.tsx.
  const ALICE_STORAGE = {
    quota_bytes: 10 * GB,
    used_bytes: 1 * GB,
    nvme_bytes: 0,
    hdd_bytes: 10 * GB,
    active_request_count: 0,
    allocations: [{
      server_id: 'srv1', server_name: 'Manager', server_state: 'active',
      node_id: 'node1', node_hostname: 'manager.local',
      drive_id: 'drive1', drive_label: 'Manager · Standard', drive_type: 'hdd',
      capacity_bytes: 100 * GB, quota_bytes: 10 * GB, used_bytes: 1 * GB, is_primary: true,
    }],
  }

  test('shows allocated quota for a user when storage details are expanded', async ({ page }) => {
    await page.route('**/api/v1/admin/users/alice/storage', async (route) => {
      await route.fulfill({ json: ALICE_STORAGE })
    })
    await page.goto('/admin/users')
    await page.getByTitle('Storage details').first().click()
    // "10.00 GB" also appears in the per-drive "used of" line, so scope to the summary bar.
    await expect(page.getByText('Allocated:')).toContainText('10.00 GB')
  })

  test('PUT /api/v1/admin/users/:username/storage/allocations is called when quota is saved', async ({ page }) => {
    await page.route('**/api/v1/admin/users/alice/storage', async (route) => {
      await route.fulfill({ json: ALICE_STORAGE })
    })
    await page.route('**/api/v1/admin/users/alice/storage/allocations', async (route) => {
      await route.fulfill({ json: { ...ALICE_STORAGE, quota_bytes: 5 * GB } })
    })
    await page.goto('/admin/users')
    await page.getByTitle('Storage details').first().click()
    await page.getByRole('button', { name: /^edit$/i }).click()
    await page.locator('input[inputmode="decimal"]').first().fill('5')

    const putReq = page.waitForRequest(
      (req) => req.method() === 'PUT' && req.url().includes('/storage/allocations'),
    )
    await page.getByRole('button', { name: /save changes/i }).click()
    const req = await putReq
    expect(req.postDataJSON()).toMatchObject({ allocations: [{ drive_id: 'drive1', quota_bytes: 5 * GB }] })
  })

  test('edit username input appears when edit button is clicked', async ({ page }) => {
    await page.goto('/admin/users')
    await page.getByTitle(/edit username/i).first().click()
    await expect(page.locator('input[value="alice"]')).toBeVisible()
  })

  test('PATCH /api/v1/admin/users/:username called when username is confirmed', async ({ page }) => {
    await page.route('**/api/v1/admin/users/**', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({ json: { ...USERS[0], username: 'alice2' } })
      } else {
        await route.fulfill({ json: { items: USERS, next_token: '' } })
      }
    })
    await page.goto('/admin/users')
    await page.getByTitle(/edit username/i).first().click()
    await page.locator('input[value="alice"]').fill('alice2')

    const patchReq = page.waitForRequest(
      (req) => req.method() === 'PATCH' && req.url().includes('/admin/users/'),
    )
    await page.getByTitle(/confirm/i).click()
    const req = await patchReq
    expect(req.url()).toContain('/admin/users/alice')
  })
})

test.describe('Admin — Requests page, Invitations tab (/admin/requests?tab=invitations)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuth(page, MOCK_ADMIN_USER)
    await mockAdminInvitations(page, INVITATIONS)
    await mockCapacity(page)
    await mockInfrastructure(page)
  })

  test('renders invitation emails from GET /api/v1/admin/invitations', async ({ page }) => {
    await page.goto('/admin/requests?tab=invitations')
    await expect(page.getByText('carol@example.com')).toBeVisible()
  })

  test('shows Pending badge for active unexpired invitation', async ({ page }) => {
    await page.goto('/admin/requests?tab=invitations')
    await expect(page.getByText('Pending', { exact: true })).toBeVisible()
  })

  test('POST /api/v1/admin/invitations is called when invite form is submitted', async ({ page }) => {
    await page.route('**/api/v1/admin/invitations', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ json: { id: 'inv2', email: 'newuser@example.com', initial_quota_bytes: 10 * GB, token_expires_at: FUTURE, accepted_at: null, revoked_at: null, invitation_url: null, invited_by_user_id: 'u1', created_at: new Date().toISOString() } })
      } else {
        await route.fulfill({ json: { items: INVITATIONS, next_token: '' } })
      }
    })
    await page.goto('/admin/requests?tab=invitations')
    await page.getByPlaceholder(/email address/i).fill('newuser@example.com')

    const postReq = page.waitForRequest(
      (req) => req.method() === 'POST' && req.url().includes('/admin/invitations'),
    )
    await page.getByRole('button', { name: /^invite$/i }).click()
    const req = await postReq
    expect(req.postDataJSON()).toMatchObject({ email: 'newuser@example.com' })
  })

  test('DELETE /api/v1/admin/invitations/:id is called when Revoke is clicked', async ({ page }) => {
    await page.route('**/api/v1/admin/invitations/inv1', async (route) => {
      await route.fulfill({ json: { message: 'revoked' } })
    })
    await page.goto('/admin/requests?tab=invitations')

    // The Revoke button triggers window.confirm — accept it
    page.on('dialog', (dialog) => dialog.accept())

    const deleteReq = page.waitForRequest(
      (req) => req.method() === 'DELETE' && req.url().includes('/admin/invitations/'),
    )
    await page.getByRole('button', { name: /revoke/i }).click()
    const req = await deleteReq
    expect(req.url()).toContain('inv1')
  })
})

test.describe('Admin — Requests page, Access Requests tab (/admin/requests?tab=access)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuth(page, MOCK_ADMIN_USER)
    await mockAdminInterest(page, SUBMISSIONS)
    await mockCapacity(page)
  })

  test('renders submission names from GET /api/v1/admin/interest', async ({ page }) => {
    await page.goto('/admin/requests?tab=access')
    // Use role-based selectors to avoid strict-mode collision with dave@example.com cell
    await expect(page.getByRole('cell', { name: 'Dave', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'dave@example.com', exact: true })).toBeVisible()
  })

  test('shows daily cap value from GET /api/v1/admin/interest/settings', async ({ page }) => {
    await page.goto('/admin/requests?tab=access')
    await expect(page.getByText('100')).toBeVisible()
  })

  test('shows Pending badge for unprovisioned submission', async ({ page }) => {
    await page.goto('/admin/requests?tab=access')
    await expect(page.getByText('Pending', { exact: true })).toBeVisible()
  })

  test('PATCH /api/v1/admin/interest/settings is called when cap is saved', async ({ page }) => {
    await page.route('**/api/v1/admin/interest/settings', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ json: { daily_cap: 50, updated_at: new Date().toISOString() } })
      } else {
        await route.fulfill({ json: { daily_cap: 100, updated_at: '2024-01-01T00:00:00Z' } })
      }
    })
    await page.goto('/admin/requests?tab=access')
    await page.getByRole('button', { name: /edit cap/i }).click()
    await page.getByPlaceholder(/new cap/i).fill('50')

    const putReq = page.waitForRequest(
      (req) => req.method() === 'PUT' && req.url().includes('/interest/settings'),
    )
    await page.getByRole('button', { name: /save/i }).click()
    const req = await putReq
    expect(req.postDataJSON()).toMatchObject({ daily_cap: 50 })
  })

  test('quota picker appears when Provision is clicked', async ({ page }) => {
    await page.goto('/admin/requests?tab=access')
    await page.getByRole('button', { name: /provision/i }).click()
    await expect(page.getByText(/choose storage quota/i)).toBeVisible()
  })
})

test.describe('Admin — Banned IPs page (/admin/banned-ips)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuth(page, MOCK_ADMIN_USER)
    await mockAdminBannedIPs(page, BANS)
  })

  test('renders IP addresses from GET /api/v1/admin/banned-ips', async ({ page }) => {
    await page.goto('/admin/banned-ips')
    await expect(page.getByText('1.2.3.4')).toBeVisible()
  })

  test('shows location for bans with geo data', async ({ page }) => {
    await page.goto('/admin/banned-ips')
    await expect(page.getByText(/New York.*US|US.*New York/)).toBeVisible()
  })

  test('shows Extend and Unban buttons for active bans', async ({ page }) => {
    await page.goto('/admin/banned-ips')
    await expect(page.getByRole('button', { name: /extend/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /unban/i })).toBeVisible()
  })

  test('POST /api/v1/admin/banned-ips/:id/unban is called when Unban is clicked', async ({ page }) => {
    await page.route('**/api/v1/admin/banned-ips/1/unban', async (route) => {
      await route.fulfill({ json: { message: 'unbanned' } })
    })
    await page.goto('/admin/banned-ips')

    // The Unban button triggers window.confirm — accept it
    page.on('dialog', (dialog) => dialog.accept())

    // unbanIP sends POST to /admin/banned-ips/:id/unban
    const unbanReq = page.waitForRequest(
      (req) => req.method() === 'POST' && req.url().includes('/unban'),
    )
    await page.getByRole('button', { name: /unban/i }).click()
    const req = await unbanReq
    expect(req.url()).toContain('/admin/banned-ips/1/unban')
  })

  test('shows empty state when no active bans', async ({ page }) => {
    await page.route('**/api/v1/admin/banned-ips**', (route) =>
      route.fulfill({ json: { items: [], next_token: '' } }),
    )
    await page.goto('/admin/banned-ips')
    await expect(page.getByText(/no active bans/i)).toBeVisible()
  })
})
