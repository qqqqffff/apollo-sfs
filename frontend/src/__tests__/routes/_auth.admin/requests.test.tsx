import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

jest.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: any) => ({ options: opts, useSearch: () => ({}) }),
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
  adminInterestInfiniteQueryOptions:    { queryKey: ['admin', 'interest'], queryFn: jest.fn() },
  interestFormSettingsQueryOptions:     { queryKey: ['admin', 'interest', 'settings'], queryFn: jest.fn() },
  capacityQueryOptions:                 { queryKey: ['admin', 'capacity'], queryFn: jest.fn() },
  infrastructureQueryOptions:           { queryKey: ['admin', 'infrastructure'], queryFn: jest.fn() },
  createInvitation:            jest.fn(),
  revokeInvitation:            jest.fn(),
  resendInvitation:            jest.fn(),
  updateInterestFormSettings:  jest.fn(),
  provisionInterestSubmission: jest.fn(),
}))

jest.mock('../../../api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor(msg: string, status = 400) { super(msg); this.status = status }
  },
}))

import { Route } from '../../../routes/_auth.admin/requests'
const Page = Route.options.component as React.ComponentType

const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
const PAST   = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
const GB = 1024 ** 3

const INVITATIONS = [
  { id: 'inv1', email: 'alice@example.com', initial_quota_bytes: 64 * GB,  token_expires_at: FUTURE, accepted_at: null, revoked_at: null, invitation_url: 'https://example.com/invite/inv1' },
  { id: 'inv2', email: 'bob@example.com',   initial_quota_bytes: 128 * GB, token_expires_at: PAST,   accepted_at: null, revoked_at: null, invitation_url: null },
  { id: 'inv3', email: 'carol@example.com', initial_quota_bytes: 256 * GB, token_expires_at: FUTURE, accepted_at: PAST, revoked_at: null, invitation_url: null },
  { id: 'inv4', email: 'dan@example.com',   initial_quota_bytes: 512 * GB, token_expires_at: FUTURE, accepted_at: null, revoked_at: PAST, invitation_url: null },
]

const SUBMISSIONS = [
  { id: 's1', name: 'Alice Req', email: 'alice.req@example.com', desired_storage_gb: 10, use_case: 'Backups',   created_at: '2024-01-01T00:00:00Z', provisioned_at: null },
  { id: 's2', name: 'Bob Req',   email: 'bob.req@example.com',   desired_storage_gb: 5,  use_case: 'Documents', created_at: '2024-01-02T00:00:00Z', provisioned_at: '2024-01-03T00:00:00Z' },
]

function setup(opts: {
  invitations?: any[]
  submissions?: any[]
  isLoading?: boolean
  error?: Error | null
  dailyCap?: number
} = {}) {
  const {
    invitations = INVITATIONS,
    submissions = SUBMISSIONS,
    isLoading = false,
    error = null,
    dailyCap = 100,
  } = opts
  mockInfiniteQuery.mockImplementation((qopts: any) => ({
    data: {
      pages: [{ items: qopts?.queryKey?.[1] === 'interest' ? submissions : invitations }],
    },
    isLoading,
    error,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(),
  }))
  mockQuery.mockImplementation((qopts: any) =>
    qopts?.queryKey?.[2] === 'settings'
      ? { data: { daily_cap: dailyCap } }
      : { data: null },
  )
  mockMutation.mockReturnValue({ mutate: jest.fn(), isPending: false })
  mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn() })
  return render(<Page />)
}

describe('Admin Requests page (invitations + access requests)', () => {
  beforeEach(() => {
    mockNotify.mockReset()
    mockQuery.mockReset()
    mockInfiniteQuery.mockReset()
  })

  test('renders the Requests page heading with both subtabs', () => {
    setup()
    expect(screen.getByRole('heading', { level: 2, name: 'Requests' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^invitations$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^access requests$/i })).toBeInTheDocument()
  })

  test('defaults to the Access Requests tab', () => {
    setup()
    expect(screen.getByText('Alice Req')).toBeInTheDocument()
  })

  test('renders email input for new invitation after switching tabs', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /^invitations$/i }))
    expect(screen.getByPlaceholderText(/email address/i)).toBeInTheDocument()
  })

  test('renders Invite submit button after switching tabs', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /^invitations$/i }))
    expect(screen.getByRole('button', { name: /^invite$/i })).toBeInTheDocument()
  })

  test('renders the standardized upgrade-panel quota presets', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /^invitations$/i }))
    ;['64 GB', '128 GB', '256 GB', '512 GB', '1 TB'].forEach((label) => {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    })
  })

  test('shows loading state on both tabs', () => {
    setup({ invitations: [], submissions: [], isLoading: true })
    expect(screen.getAllByText(/loading/i).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /^invitations$/i }))
    expect(screen.getAllByText(/loading/i).length).toBeGreaterThan(0)
  })

  test('shows error state on the access requests tab', () => {
    setup({ invitations: [], submissions: [], error: new Error('fail') })
    expect(screen.getByText(/failed to load submissions/i)).toBeInTheDocument()
  })

  test('shows error state on the invitations tab', () => {
    setup({ invitations: [], submissions: [], error: new Error('fail') })
    fireEvent.click(screen.getByRole('button', { name: /^invitations$/i }))
    expect(screen.getByText(/failed to load invitations/i)).toBeInTheDocument()
  })

  test('renders invitation email addresses', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /^invitations$/i }))
    INVITATIONS.forEach((inv) => expect(screen.getByText(inv.email)).toBeInTheDocument())
  })

  test('shows invitation status badges', () => {
    setup({ submissions: [] })
    fireEvent.click(screen.getByRole('button', { name: /^invitations$/i }))
    expect(screen.getByText('Pending')).toBeInTheDocument()
    expect(screen.getByText('Accepted')).toBeInTheDocument()
    expect(screen.getByText('Revoked')).toBeInTheDocument()
    expect(screen.getByText('Expired')).toBeInTheDocument()
  })

  test('shows Revoke button for pending invitation', () => {
    setup({ invitations: [INVITATIONS[0]], submissions: [] })
    fireEvent.click(screen.getByRole('button', { name: /^invitations$/i }))
    expect(screen.getByRole('button', { name: /revoke/i })).toBeInTheDocument()
  })

  test('shows Copy link button for pending invitation with URL', () => {
    setup({ invitations: [INVITATIONS[0]], submissions: [] })
    fireEvent.click(screen.getByRole('button', { name: /^invitations$/i }))
    expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument()
  })

  test('Custom quota button toggles custom input', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /^invitations$/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /custom/i })[0])
    expect(screen.getByPlaceholderText('GB')).toBeInTheDocument()
  })

  test('renders Grant admin access checkbox unchecked by default', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /^invitations$/i }))
    const checkbox = screen.getByRole('checkbox', { name: /grant admin access/i })
    expect(checkbox).toBeInTheDocument()
    expect(checkbox).not.toBeChecked()
  })

  // ── Access requests section ─────────────────────────────────────────────────

  test('displays daily cap value', () => {
    setup({ invitations: [], submissions: [], dailyCap: 50 })
    expect(screen.getByText('50')).toBeInTheDocument()
  })

  test('clicking Edit cap shows an input field', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /edit cap/i }))
    expect(screen.getByPlaceholderText(/new cap/i)).toBeInTheDocument()
  })

  test('renders submission names and emails', () => {
    setup()
    expect(screen.getByText('Alice Req')).toBeInTheDocument()
    expect(screen.getByText('alice.req@example.com')).toBeInTheDocument()
    expect(screen.getByText('Bob Req')).toBeInTheDocument()
  })

  test('shows Provisioned badge for provisioned submissions', () => {
    setup()
    expect(screen.getByText('Provisioned')).toBeInTheDocument()
  })

  test('shows Provision button only for unprovisioned submissions', () => {
    setup()
    expect(screen.getAllByRole('button', { name: /^provision$/i })).toHaveLength(1)
  })

  test('shows empty state when no submissions', () => {
    setup({ submissions: [] })
    expect(screen.getByText(/no submissions yet/i)).toBeInTheDocument()
  })

  test('clicking Provision shows quota picker with standardized presets', () => {
    setup({ invitations: [], submissions: [SUBMISSIONS[0]] })
    fireEvent.click(screen.getByRole('button', { name: /^provision$/i }))
    expect(screen.getByText(/choose storage quota/i)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '64 GB' }).length).toBeGreaterThan(0)
  })

  test('Grant admin access checkbox can be toggled in provision panel', () => {
    setup({ invitations: [], submissions: [SUBMISSIONS[0]] })
    fireEvent.click(screen.getByRole('button', { name: /^provision$/i }))
    const checkboxes = screen.getAllByRole('checkbox', { name: /grant admin access/i })
    const panelCheckbox = checkboxes[checkboxes.length - 1]
    fireEvent.click(panelCheckbox)
    expect(panelCheckbox).toBeChecked()
  })
})
