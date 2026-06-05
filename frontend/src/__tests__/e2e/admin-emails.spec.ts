import { test, expect, Page } from '@playwright/test'
import { mockAuth, MOCK_ADMIN_USER } from './fixtures'

const WORKERS = [
  { worker_name: 'support', total_count: 3, unread_count: 2 },
  { worker_name: 'billing', total_count: 1, unread_count: 0 },
]

const EMAILS = [
  {
    id: 'e1',
    worker_name: 'support',
    from_addr: 'alice@example.com',
    to_addr: 'support@example.com',
    subject: 'Need help',
    has_attachments: false,
    read: false,
    received_at: '2026-05-01T10:00:00Z',
  },
]

const DETAIL = {
  ...EMAILS[0],
  message: {
    message_id: '<x@y>',
    from: 'alice@example.com',
    to: 'support@example.com',
    subject: 'Need help',
    date: '2026-05-01T10:00:00Z',
    text: 'please assist',
    html: '', // empty html => plain-text path, body visible in the main DOM
    headers: '',
    attachments: [],
  },
}

// Register the catch-all FIRST so the more-specific /workers route (registered
// second) takes priority — Playwright evaluates most-recently-added routes first.
async function mockAdminEmails(page: Page) {
  await page.route('**/api/v1/admin/emails**', async (route) => {
    const req = route.request()
    const method = req.method()
    if (method === 'DELETE') return route.fulfill({ json: { message: 'deleted' } })
    if (method === 'PATCH') return route.fulfill({ json: { message: 'ok' } })

    // GET: distinguish a detail fetch (/admin/emails/<id>) from a list fetch.
    const path = new URL(req.url()).pathname
    const after = path.split('/api/v1/admin/emails')[1] ?? ''
    if (after && after !== '/workers') {
      return route.fulfill({ json: DETAIL })
    }
    return route.fulfill({ json: { items: EMAILS, next_token: '' } })
  })
  await page.route('**/api/v1/admin/emails/workers', (route) =>
    route.fulfill({ json: { workers: WORKERS } }),
  )
}

test.describe('Admin — Service emails page (/admin/emails)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuth(page, MOCK_ADMIN_USER)
    await mockAdminEmails(page)
  })

  test('renders worker mailboxes and the email list', async ({ page }) => {
    await page.goto('/admin/emails')
    await expect(page.getByRole('heading', { name: /service emails/i })).toBeVisible()
    // Worker sidebar (anchored so the email-row "support" chip doesn't collide)
    await expect(page.getByRole('button', { name: /^support/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^billing/ })).toBeVisible()
    // Email list row
    await expect(page.getByText('alice@example.com')).toBeVisible()
    await expect(page.getByText('Need help')).toBeVisible()
  })

  test('opening an email shows the detail pane and fires mark-read', async ({ page }) => {
    await page.goto('/admin/emails')

    const readReq = page.waitForRequest(
      (req) => req.method() === 'PATCH' && req.url().includes('/admin/emails/e1/read'),
    )
    await page.getByText('Need help').click()

    await expect(page.getByText(/From:/)).toBeVisible()
    await expect(page.getByText('please assist')).toBeVisible()
    await readReq
  })

  test('deleting an email requires confirmation then fires DELETE', async ({ page }) => {
    await page.goto('/admin/emails')
    await page.getByText('Need help').click()

    await page.getByRole('button', { name: /^Delete$/ }).click()

    const deleteReq = page.waitForRequest(
      (req) => req.method() === 'DELETE' && req.url().includes('/admin/emails/e1'),
    )
    await page.getByRole('button', { name: /confirm delete/i }).click()
    const req = await deleteReq
    expect(req.url()).toContain('/admin/emails/e1')
  })

  test('navigating via the Emails nav link reaches the page', async ({ page }) => {
    await page.goto('/admin/emails')
    // The admin nav exposes an Emails link; clicking it stays on the page.
    await page.getByRole('link', { name: /^Emails$/ }).first().click()
    await expect(page.getByRole('heading', { name: /service emails/i })).toBeVisible()
  })
})
