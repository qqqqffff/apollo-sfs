import { Page } from '@playwright/test'

export const GB = 1024 ** 3

export const MOCK_USER = {
  username: 'alice',
  email: 'alice@example.com',
  is_admin: false,
  storage_used_bytes: 1 * GB,
  storage_quota_bytes: 10 * GB,
  created_at: '2024-01-01T00:00:00Z',
  last_seen_at: null,
  is_premium: false,
  premium_granted_at: null,
  premium_subscribed: false,
  linked_providers: [] as string[],
  sandbox_payments_enabled: false,
  expansion_override_enabled: false,
  feedback_access_enabled: false,
}

export const MOCK_ADMIN_USER = { ...MOCK_USER, is_admin: true }

export const MOCK_FOLDERS = [
  { id: 'fold1', name: 'Photos',    parent_id: null, user_id: 'u1', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
  { id: 'fold2', name: 'Documents', parent_id: null, user_id: 'u1', created_at: '2024-01-02T00:00:00Z', updated_at: '2024-01-02T00:00:00Z' },
]

export const MOCK_FILES = [
  { id: 'fi1', name: 'report.pdf', size_bytes: 512 * 1024, mime_type: 'application/pdf', folder_id: null, user_id: 'u1', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
  { id: 'fi2', name: 'note.txt',   size_bytes: 1024,       mime_type: 'text/plain',       folder_id: null, user_id: 'u1', created_at: '2024-01-02T00:00:00Z', updated_at: '2024-01-02T00:00:00Z' },
]

/**
 * Intercept /api/v1/me and return the given user so auth checks pass.
 *
 * Also stubs GET /api/v1/me/preferences with the onboarding "seen" flags
 * already set (see OnboardingGuideContext) so the first-time-user spotlight
 * tour doesn't auto-open — its full-screen blocking overlay would otherwise
 * intercept every click in tests that aren't exercising onboarding itself.
 *
 * Also stubs GET /api/v1/me/notifications — NotificationBell (rendered in
 * the shared _auth layout nav, so present on every authenticated page, not
 * just /client) polls it on mount. Left unmocked it 500s against whatever
 * dev server backs baseURL, and since an errored query has no cached data,
 * every remount refetches immediately (no backoff), spamming the endpoint
 * and destabilizing the whole page (elements shifting under in-flight
 * clicks) until it eventually blows past the suite timeout.
 */
export async function mockAuth(page: Page, user = MOCK_USER) {
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({ json: user }),
  )
  await page.route('**/api/v1/me/notifications', (route) =>
    route.fulfill({ json: { items: [], next_token: '' } }),
  )
  await mockPreferences(page)
}

/**
 * GET /api/v1/me/preferences payload used across the E2E suite. Only the
 * onboarding flags matter to most specs — with both true the spotlight tour
 * stays closed (see mockAuth). Every stub of this endpoint should use it
 * rather than `{}`: Playwright gives precedence to the most recently
 * registered matching route, so one `{}` stub added after mockAuth would
 * silently bring the blocking tour overlay back.
 */
export const MOCK_PREFERENCES = {
  onboarding_base_seen: true,
  onboarding_premium_seen: true,
}

export async function mockPreferences(page: Page) {
  await page.route('**/api/v1/me/preferences', (route) =>
    route.fulfill({ json: MOCK_PREFERENCES }),
  )
}

export const MOCK_SERVER = {
  server_id: 'srv1',
  drive_id: 'drive1',
  name: 'Manager',
  state: 'active',
  drive_type: 'hdd' as const,
  capacity_bytes: 8 * 1024 ** 4,
  used_bytes: 1 * GB,
  drive_used_pct: 12.5,
  quota_bytes: 10 * GB,
  is_primary: true,
  ping_url: '',
}

/**
 * Stub GET /api/v1/folders* with root folder contents.
 * Response shape matches FolderContents: { folder, subfolders: PageResult, files: PageResult }
 *
 * Also stubs the other requests the client root page (`RootView` in
 * _auth.client/index.tsx) fires alongside folder contents — storage/my-servers
 * (gates the page behind a "Loading…" state; a single server routes straight
 * into the plain files view instead of the multi-drive picker, matching this
 * fixture's single-drive assumption), me/preferences, and favorites. Same
 * unmocked-500-causes-a-refetch-storm hazard as /me/notifications — see mockAuth.
 */
export async function mockRootFolder(
  page: Page,
  folders = MOCK_FOLDERS,
  files = MOCK_FILES,
) {
  await page.route('**/api/v1/folders**', (route) =>
    route.fulfill({
      json: {
        folder: null,
        subfolders: { items: folders, next_token: '' },
        files:      { items: files,   next_token: '' },
      },
    }),
  )
  await page.route('**/api/v1/storage/my-servers', (route) =>
    route.fulfill({ json: { servers: [MOCK_SERVER] } }),
  )
  await mockPreferences(page)
  await mockFavorites(page)
}

/** Stub admin paginated list endpoints (PageResult = { items, next_token }). */
export async function mockAdminUsers(page: Page, users: object[] = []) {
  await page.route('**/api/v1/admin/users**', (route) =>
    route.fulfill({ json: { items: users, next_token: '' } }),
  )
}

export async function mockAdminInvitations(page: Page, invitations: object[] = []) {
  await page.route('**/api/v1/admin/invitations**', (route) =>
    route.fulfill({ json: { items: invitations, next_token: '' } }),
  )
}

export async function mockAdminInterest(page: Page, submissions: object[] = []) {
  // Register the catch-all FIRST so the more-specific settings route (registered
  // second) takes priority — Playwright evaluates most-recently-added routes first.
  await page.route('**/api/v1/admin/interest**', (route) =>
    route.fulfill({ json: { items: submissions, next_token: '' } }),
  )
  await page.route('**/api/v1/admin/interest/settings', (route) =>
    route.fulfill({ json: { daily_cap: 100, updated_at: '2024-01-01T00:00:00Z' } }),
  )
}

export async function mockAdminBannedIPs(page: Page, bans: object[] = []) {
  await page.route('**/api/v1/admin/banned-ips**', (route) =>
    route.fulfill({ json: { items: bans, next_token: '' } }),
  )
}

export async function mockCapacity(page: Page) {
  await page.route('**/api/v1/admin/capacity', (route) =>
    route.fulfill({ json: null }),
  )
}

/** Stub GET /admin/system/infrastructure — pulled in by the Requests page's Invitations tab for its drive picker. */
export async function mockInfrastructure(page: Page) {
  await page.route('**/api/v1/admin/system/infrastructure', (route) =>
    route.fulfill({ json: { nodes: [], drives: [], disks: [] } }),
  )
}

export async function mockFavorites(page: Page, files: object[] = [], folders: object[] = []) {
  await page.route('**/api/v1/favorites', (route) =>
    route.fulfill({ json: { files, folders } }),
  )
}
