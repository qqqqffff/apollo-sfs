import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

jest.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: any) => ({ options: opts }),
}))

const mockInfiniteQuery = jest.fn()
const mockQuery = jest.fn()
const mockMutation = jest.fn()
const mockQueryClient = jest.fn()

jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useInfiniteQuery: (...args: any[]) => mockInfiniteQuery(...args),
  useQuery:         (...args: any[]) => mockQuery(...args),
  useMutation:      (...args: any[]) => mockMutation(...args),
  useQueryClient:   () => mockQueryClient(),
}))

const mockNotify = jest.fn()
jest.mock('../../../context/NotificationContext', () => ({
  useNotification: () => ({ notify: mockNotify }),
}))

jest.mock('../../../api/admin', () => ({
  adminInvitationsInfiniteQueryOptions: { queryKey: ['admin', 'invitations'], queryFn: jest.fn() },
  capacityQueryOptions: { queryKey: ['admin', 'capacity'], queryFn: jest.fn() },
  createInvitation:  jest.fn(),
  revokeInvitation:  jest.fn(),
  resendInvitation:  jest.fn(),
}))

jest.mock('../../../api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor(msg: string, status = 400) { super(msg); this.status = status }
  },
}))

import { Route } from '../../../routes/_auth.admin/invitations'
const Page = Route.options.component as React.ComponentType

const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
const PAST   = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
const GB = 1024 ** 3

const INVITATIONS = [
  { id: 'inv1', email: 'alice@example.com', initial_quota_bytes: 10 * GB, token_expires_at: FUTURE, accepted_at: null,   revoked_at: null, invitation_url: 'https://example.com/invite/inv1' },
  { id: 'inv2', email: 'bob@example.com',   initial_quota_bytes: 5  * GB, token_expires_at: PAST,   accepted_at: null,   revoked_at: null, invitation_url: null },
  { id: 'inv3', email: 'carol@example.com', initial_quota_bytes: 20 * GB, token_expires_at: FUTURE, accepted_at: PAST,   revoked_at: null, invitation_url: null },
  { id: 'inv4', email: 'dan@example.com',   initial_quota_bytes: 1  * GB, token_expires_at: FUTURE, accepted_at: null,   revoked_at: PAST, invitation_url: null },
]

function setup(invitations = INVITATIONS, overrides: { isLoading?: boolean; error?: Error | null } = {}) {
  const { isLoading = false, error = null } = overrides
  mockInfiniteQuery.mockReturnValue({
    data: { pages: [{ items: invitations }] },
    isLoading,
    error,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(),
  })
  mockQuery.mockReturnValue({ data: null })
  mockMutation.mockReturnValue({ mutate: jest.fn(), isPending: false })
  mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn() })
  return render(<Page />)
}

describe('Admin Invitations page', () => {
  beforeEach(() => mockNotify.mockReset())

  test('renders Invitations heading', () => {
    setup()
    expect(screen.getByRole('heading', { name: /invitations/i })).toBeInTheDocument()
  })

  test('renders email input for new invitation', () => {
    setup()
    expect(screen.getByPlaceholderText(/email address/i)).toBeInTheDocument()
  })

  test('renders Invite submit button', () => {
    setup()
    expect(screen.getByRole('button', { name: /invite/i })).toBeInTheDocument()
  })

  test('renders all quota preset buttons', () => {
    setup()
    ;['1 GB', '5 GB', '10 GB', '25 GB', '50 GB', '100 GB'].forEach((label) => {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    })
  })

  test('shows loading state', () => {
    setup([], { isLoading: true })
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  test('shows error state', () => {
    setup([], { error: new Error('fail') })
    expect(screen.getByText(/failed to load invitations/i)).toBeInTheDocument()
  })

  test('renders invitation email addresses', () => {
    setup()
    INVITATIONS.forEach((inv) => expect(screen.getByText(inv.email)).toBeInTheDocument())
  })

  test('shows Pending badge for active unexpired invitation', () => {
    setup()
    expect(screen.getByText('Pending')).toBeInTheDocument()
  })

  test('shows Accepted badge', () => {
    setup()
    expect(screen.getByText('Accepted')).toBeInTheDocument()
  })

  test('shows Revoked badge', () => {
    setup()
    expect(screen.getByText('Revoked')).toBeInTheDocument()
  })

  test('shows Expired badge for expired pending invitation', () => {
    setup()
    expect(screen.getByText('Expired')).toBeInTheDocument()
  })

  test('shows Revoke button for pending invitation', () => {
    setup([INVITATIONS[0]])
    expect(screen.getByRole('button', { name: /revoke/i })).toBeInTheDocument()
  })

  test('shows Copy link button for pending invitation with URL', () => {
    setup([INVITATIONS[0]])
    expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument()
  })

  test('Custom quota button toggles custom input', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /custom/i }))
    expect(screen.getByPlaceholderText('GB')).toBeInTheDocument()
  })

  test('renders Grant admin access checkbox unchecked by default', () => {
    setup()
    const checkbox = screen.getByRole('checkbox', { name: /grant admin access/i })
    expect(checkbox).toBeInTheDocument()
    expect(checkbox).not.toBeChecked()
  })

  test('Grant admin access checkbox can be toggled', () => {
    setup()
    const checkbox = screen.getByRole('checkbox', { name: /grant admin access/i })
    fireEvent.click(checkbox)
    expect(checkbox).toBeChecked()
  })
})
