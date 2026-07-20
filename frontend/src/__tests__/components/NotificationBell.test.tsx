import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockNavigate = jest.fn()
jest.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

jest.mock('../../api/billing', () => ({
  listNotifications: jest.fn(),
  dismissNotifications: jest.fn(),
  dismissNotificationCategory: jest.fn(),
}))

import {
  listNotifications,
  dismissNotifications,
  dismissNotificationCategory,
  type AppNotification,
} from '../../api/billing'
import { NotificationBell } from '../../components/NotificationBell'

const mockListNotifications = listNotifications as jest.Mock
const mockDismissNotifications = dismissNotifications as jest.Mock
const mockDismissNotificationCategory = dismissNotificationCategory as jest.Mock

// Mirrors the kind→category map in NotificationBell.tsx, just for the two
// kinds these tests use.
const CATEGORY_BY_KIND: Record<string, string> = {
  share_received: 'Shares',
  email_received: 'Emails',
}

function makeNotification(overrides: Partial<AppNotification>): AppNotification {
  return {
    id: 'id-1',
    kind: 'share_received',
    title: 'Title',
    body: 'Body',
    link: '/client/shared',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

// listNotifications/dismissNotifications(Category) share a mutable in-memory
// list so a dismiss-triggered refetch (onSettled invalidation) sees the item
// actually gone server-side, the same as the real API filtering dismissed
// IDs/category out.
function renderBell(items: AppNotification[]) {
  let current = items
  mockListNotifications.mockImplementation(() => Promise.resolve(current))
  mockDismissNotifications.mockImplementation((ids: string[]) => {
    current = current.filter((n) => !ids.includes(n.id))
    return Promise.resolve()
  })
  mockDismissNotificationCategory.mockImplementation((category: string) => {
    current = current.filter((n) => CATEGORY_BY_KIND[n.kind] !== category)
    return Promise.resolve()
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <NotificationBell />
    </QueryClientProvider>,
  )
}

describe('NotificationBell', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shows an empty state when there are no notifications', async () => {
    renderBell([])
    fireEvent.click(screen.getByTitle('Notifications'))
    expect(await screen.findByText("You're all caught up.")).toBeInTheDocument()
  })

  it('groups items by category and collapses the Emails category by default', async () => {
    renderBell([
      makeNotification({ id: 's1', kind: 'share_received', title: 'A file was shared with you' }),
      makeNotification({ id: 'e1', kind: 'email_received', title: 'Email received' }),
    ])
    fireEvent.click(screen.getByTitle('Notifications'))

    expect(await screen.findByText('A file was shared with you')).toBeInTheDocument()
    // Emails category header is shown with its count, but the item underneath
    // starts collapsed.
    expect(screen.getByText(/Emails \(1\)/)).toBeInTheDocument()
    expect(screen.queryByText('Email received')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText(/Emails \(1\)/))
    expect(await screen.findByText('Email received')).toBeInTheDocument()
  })

  it('dismisses a single notification and persists it via the API', async () => {
    renderBell([makeNotification({ id: 's1', kind: 'share_received', title: 'A file was shared with you' })])
    fireEvent.click(screen.getByTitle('Notifications'))
    await screen.findByText('A file was shared with you')

    fireEvent.click(screen.getByTitle('Dismiss'))

    await waitFor(() => expect(mockDismissNotifications).toHaveBeenCalledWith(['s1']))
    await waitFor(() => expect(screen.queryByText('A file was shared with you')).not.toBeInTheDocument())
    // Dismissing an item is not the same as opening it — no navigation.
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('shows a Breakdown toggle for quota_changed items and expands the before/after table', async () => {
    renderBell([
      makeNotification({
        id: 'q1',
        kind: 'quota_changed',
        title: 'Storage allocation updated',
        body: 'An admin updated your storage across 1 drive: 50 GB → 80 GB total.',
        details: {
          reason: 'Needed more room',
          before: [{ drive_id: 'd1', server_name: 'Manager', drive_type: 'hdd', quota_bytes: 50 * 1024 ** 3 }],
          after: [{ drive_id: 'd1', server_name: 'Manager', drive_type: 'hdd', quota_bytes: 80 * 1024 ** 3 }],
        },
      }),
    ])
    fireEvent.click(screen.getByTitle('Notifications'))
    await screen.findByText('Storage allocation updated')

    expect(screen.queryByText('Needed more room', { exact: false })).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Show breakdown'))

    expect(await screen.findByText(/Needed more room/)).toBeInTheDocument()
    expect(screen.getByText('50.00 GB')).toBeInTheDocument()
    expect(screen.getByText('80.00 GB')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Hide breakdown'))
    expect(screen.queryByText(/Needed more room/)).not.toBeInTheDocument()
  })

  it('dismisses an entire category with "Dismiss all"', async () => {
    renderBell([
      makeNotification({ id: 's1', kind: 'share_received', title: 'Share one' }),
      makeNotification({ id: 's2', kind: 'share_received', title: 'Share two' }),
    ])
    fireEvent.click(screen.getByTitle('Notifications'))
    await screen.findByText('Share one')

    fireEvent.click(screen.getByText('Dismiss all'))

    await waitFor(() => expect(mockDismissNotificationCategory).toHaveBeenCalledWith('Shares'))
    await waitFor(() => expect(screen.queryByText('Share one')).not.toBeInTheDocument())
    expect(screen.queryByText('Share two')).not.toBeInTheDocument()
  })
})
