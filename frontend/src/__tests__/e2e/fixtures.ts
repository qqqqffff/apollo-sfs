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

/** Intercept /api/v1/me and return the given user so auth checks pass. */
export async function mockAuth(page: Page, user = MOCK_USER) {
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({ json: user }),
  )
}

/**
 * Stub GET /api/v1/folders* with root folder contents.
 * Response shape matches FolderContents: { folder, subfolders: PageResult, files: PageResult }
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

export async function mockFavorites(page: Page, files: object[] = [], folders: object[] = []) {
  await page.route('**/api/v1/favorites', (route) =>
    route.fulfill({ json: { files, folders } }),
  )
}
