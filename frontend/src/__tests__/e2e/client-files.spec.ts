import { test, expect } from '@playwright/test'
import {
  mockAuth,
  mockRootFolder,
  MOCK_FOLDERS,
  MOCK_FILES,
  GB,
} from './fixtures'

test.describe('Client — Files page (/client)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuth(page)
    await mockRootFolder(page)
  })

  test('shows My Files heading at root', async ({ page }) => {
    await page.goto('/client')
    await expect(page.getByRole('heading', { name: /my files/i })).toBeVisible()
  })

  test('renders folder names returned by the API', async ({ page }) => {
    await page.goto('/client')
    await expect(page.getByText('Photos', { exact: true })).toBeVisible()
    await expect(page.getByText('Documents', { exact: true })).toBeVisible()
  })

  test('renders file names returned by the API', async ({ page }) => {
    await page.goto('/client')
    await expect(page.getByText('report.pdf', { exact: true })).toBeVisible()
    await expect(page.getByText('note.txt', { exact: true })).toBeVisible()
  })

  test('shows quota bar with used/quota values from /api/v1/me', async ({ page }) => {
    await page.goto('/client')
    await expect(page.getByText(/used/)).toBeVisible()
    await expect(page.getByText(/quota/)).toBeVisible()
  })

  test('New folder button is present and clickable', async ({ page }) => {
    await page.goto('/client')
    const btn = page.getByRole('button', { name: /new folder/i })
    await expect(btn).toBeVisible()
    await btn.click()
    await expect(page.getByPlaceholder(/folder name/i)).toBeVisible()
  })

  test('Escape cancels new-folder input', async ({ page }) => {
    await page.goto('/client')
    await page.getByRole('button', { name: /new folder/i }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByPlaceholder(/folder name/i)).not.toBeVisible()
  })

  test('POST /api/v1/folders is called when a new folder is confirmed', async ({ page }) => {
    // Override the folders route to handle both GET (list) and POST (create)
    await page.route('**/api/v1/folders**', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          json: { id: 'new1', name: 'NewFolder', parent_id: null, user_id: 'u1', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        })
      } else {
        await route.fulfill({
          json: {
            folder: null,
            subfolders: { items: MOCK_FOLDERS, next_token: '' },
            files:      { items: MOCK_FILES,   next_token: '' },
          },
        })
      }
    })

    await page.goto('/client')
    await page.getByRole('button', { name: /new folder/i }).click()
    await page.getByPlaceholder(/folder name/i).fill('NewFolder')

    const postReq = page.waitForRequest(
      (req) => req.method() === 'POST' && req.url().includes('/api/v1/folders'),
    )
    await page.keyboard.press('Enter')
    const req = await postReq
    expect(req.postDataJSON()).toMatchObject({ name: 'NewFolder' })
  })

  test('clicking Delete on a file triggers DELETE /api/v1/files/:id', async ({ page }) => {
    await page.route('**/api/v1/files/**', async (route) => {
      await route.fulfill({ json: { message: 'deleted' } })
    })

    await page.goto('/client')
    // Click the first file Delete button (after 2 folder buttons)
    const deleteButtons = page.getByRole('button', { name: /^delete$/i })
    await deleteButtons.nth(2).click()

    // DeleteConfirmModal appears — click the modal's "Delete" confirm button
    const deleteReq = page.waitForRequest(
      (req) => req.method() === 'DELETE' && req.url().includes('/api/v1/files/'),
    )
    await page.getByRole('button', { name: /^delete$/i }).last().click()
    const req = await deleteReq
    // Verify a DELETE was sent to the files API (sort order may vary)
    expect(req.url()).toMatch(/\/api\/v1\/files\/fi\d/)
  })

  test('shows empty-state message when API returns no files or folders', async ({ page }) => {
    await page.route('**/api/v1/folders**', (route) =>
      route.fulfill({
        json: {
          folder: null,
          subfolders: { items: [], next_token: '' },
          files:      { items: [], next_token: '' },
        },
      }),
    )
    await page.goto('/client')
    await expect(page.getByText(/no files yet/i)).toBeVisible()
  })

  test('unauthenticated user is redirected to /login', async ({ page }) => {
    await page.route('**/api/v1/me', (route) =>
      route.fulfill({ status: 401, json: { error: 'unauthorized' } }),
    )
    await page.goto('/client')
    await expect(page).toHaveURL(/\/login/)
  })
})

test.describe('Client — Favorites page (/client/favorites)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuth(page)
  })

  test('shows empty-state when no favorites returned by API', async ({ page }) => {
    await page.route('**/api/v1/favorites', (route) =>
      route.fulfill({ json: { files: [], folders: [] } }),
    )
    await page.goto('/client/favorites')
    await expect(page.getByText(/no favorites yet/i)).toBeVisible()
  })

  test('renders favorite folder names from GET /api/v1/favorites', async ({ page }) => {
    await page.route('**/api/v1/favorites', (route) =>
      route.fulfill({
        json: {
          folders: [{ id: 'f1', name: 'Starred Folder' }],
          files: [],
        },
      }),
    )
    await page.goto('/client/favorites')
    await expect(page.getByText('Starred Folder', { exact: true })).toBeVisible()
  })

  test('renders favorite file names and sizes from GET /api/v1/favorites', async ({ page }) => {
    await page.route('**/api/v1/favorites', (route) =>
      route.fulfill({
        json: {
          folders: [],
          files: [{ id: 'fi1', name: 'starred.pdf', size_bytes: 2 * GB, mime_type: 'application/pdf' }],
        },
      }),
    )
    await page.goto('/client/favorites')
    await expect(page.getByText('starred.pdf', { exact: true })).toBeVisible()
    await expect(page.getByText('2.0 GB')).toBeVisible()
  })

  test('DELETE /api/v1/favorites/files/:id is called when remove button clicked', async ({ page }) => {
    await page.route('**/api/v1/favorites**', async (route) => {
      await route.fulfill({ json: { message: 'ok' } })
    })
    await page.route('**/api/v1/favorites', (route) =>
      route.fulfill({
        json: {
          folders: [],
          files: [{ id: 'fi1', name: 'starred.pdf', size_bytes: 1024, mime_type: 'text/plain' }],
        },
      }),
    )
    await page.goto('/client/favorites')

    const removeReq = page.waitForRequest(
      (req) => req.method() === 'DELETE' && req.url().includes('/favorites/files/'),
    )
    await page.getByTitle(/remove from favorites/i).click()
    const req = await removeReq
    expect(req.url()).toContain('fi1')
  })
})

test.describe('Client — Profile page (/client/profile)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuth(page)
  })

  test('shows email from GET /api/v1/me', async ({ page }) => {
    await page.goto('/client/profile')
    await expect(page.getByText('alice@example.com')).toBeVisible()
  })

  test('shows storage usage percentage', async ({ page }) => {
    await page.goto('/client/profile')
    await expect(page.getByText(/10\.0%\s*used/i)).toBeVisible()
  })

  test('PATCH /api/v1/me/password is called on password form submit', async ({ page }) => {
    await page.route('**/api/v1/me/password', async (route) => {
      await route.fulfill({ json: { message: 'ok' } })
    })
    await page.goto('/client/profile')

    const inputs = page.locator('input[type="password"]')
    await inputs.nth(0).fill('OldPass1!')
    await inputs.nth(1).fill('NewPass1!')
    await inputs.nth(2).fill('NewPass1!')

    const patchReq = page.waitForRequest(
      (req) => req.method() === 'POST' && req.url().includes('/me/password'),
    )
    await page.getByRole('button', { name: /update password/i }).click()
    const req = await patchReq
    expect(req.postDataJSON()).toMatchObject({
      current_password: 'OldPass1!',
      new_password: 'NewPass1!',
    })
  })

  test('shows password requirement checklist when typing in new-password field', async ({ page }) => {
    await page.goto('/client/profile')
    const inputs = page.locator('input[type="password"]')
    await inputs.nth(1).focus()
    await expect(page.getByText(/at least 8 characters/i)).toBeVisible()
  })

  test('Update password button is disabled until all requirements met', async ({ page }) => {
    await page.goto('/client/profile')
    const btn = page.getByRole('button', { name: /update password/i })
    await expect(btn).toBeDisabled()
  })
})
