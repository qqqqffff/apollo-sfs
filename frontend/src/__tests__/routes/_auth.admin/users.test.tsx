import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

const mockNavigate = jest.fn()
jest.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: any) => ({ options: opts, useSearch: () => ({}) }),
  useNavigate: () => mockNavigate,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
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

const mockImpersonate = jest.fn()
jest.mock('../../../context/ImpersonationContext', () => ({
  useImpersonation: () => ({ impersonate: mockImpersonate, clearImpersonation: jest.fn(), impersonatedUser: null }),
}))

jest.mock('../../../api/admin', () => ({
  searchAdminUsers: jest.fn(),
  getAdminUserStorage: jest.fn(),
  updateUserStorageAllocations: jest.fn(),
  infrastructureQueryOptions: { queryKey: ['admin', 'infrastructure'], queryFn: jest.fn() },
  updateUsername: jest.fn(),
  logImpersonationAccess: jest.fn().mockResolvedValue({ ok: true }),
  getAdminAuditLogs: jest.fn(),
  banUser: jest.fn(),
  suspendUser: jest.fn(),
  pardonUser: jest.fn(),
}))

jest.mock('../../../api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number; body: any
    constructor(msg: string, status = 400, body: any = {}) { super(msg); this.status = status; this.body = body }
  },
}))

jest.mock('../../../api/me', () => ({
  meQueryOptions: { queryKey: ['me'], queryFn: jest.fn() },
}))

import { Route } from '../../../routes/_auth.admin/users'
const Page = Route.options.component as React.ComponentType

const USERS = [
  { username: 'alice', email: 'alice@example.com', is_admin: false, is_premium: false, created_at: '2026-01-01T00:00:00Z', last_seen_at: null },
  { username: 'bob',   email: 'bob@example.com',   is_admin: true,  is_premium: false, created_at: '2026-02-01T00:00:00Z', last_seen_at: null },
]

function setup(overrides: { isLoading?: boolean; error?: Error | null; users?: typeof USERS; total?: number; page?: number } = {}) {
  const { isLoading = false, error = null, users = USERS, total = users.length, page = 1 } = overrides
  mockQuery.mockImplementation((options: any) => {
    if (options?.queryKey?.[0] === 'me') {
      return { data: { username: 'alice' } }
    }
    if (options?.queryKey?.[0] === 'admin' && options?.queryKey?.[1] === 'infrastructure') {
      return { data: { nodes: [], drives: [], disks: [] } }
    }
    return {
      data: isLoading || error ? undefined : { items: users, total, page, page_size: 25 },
      isLoading,
      error,
    }
  })
  mockMutation.mockReturnValue({ mutate: jest.fn(), isPending: false, variables: undefined })
  mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn() })
  window.prompt = jest.fn().mockReturnValue(null)
  return render(<Page />)
}

describe('Admin Users page', () => {
  beforeEach(() => {
    mockNotify.mockReset()
    mockImpersonate.mockReset()
    mockNavigate.mockReset()
  })

  test('renders Users heading', () => {
    setup()
    expect(screen.getByRole('heading', { name: /users/i })).toBeInTheDocument()
  })

  test('shows loading state', () => {
    setup({ isLoading: true, users: [] })
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  test('shows error state', () => {
    setup({ error: new Error('oops'), users: [] })
    expect(screen.getByText(/failed to load users/i)).toBeInTheDocument()
  })

  test('renders user rows', () => {
    setup()
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('alice@example.com')).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.getByText('bob@example.com')).toBeInTheDocument()
  })

  test('does not render quota/used/status columns', () => {
    setup()
    expect(screen.queryByRole('columnheader', { name: /^quota$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: /^used$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: /status/i })).not.toBeInTheDocument()
  })

  test('renders a Created column with each user\'s created date', () => {
    setup()
    expect(screen.getByRole('columnheader', { name: /created/i })).toBeInTheDocument()
    expect(screen.getByText(new Date(USERS[0].created_at).toLocaleDateString())).toBeInTheDocument()
  })

  test('renders search box, role filter, server filter, and tier checkboxes', () => {
    setup()
    expect(screen.getByPlaceholderText(/search username or email/i)).toBeInTheDocument()
    expect(screen.getAllByRole('combobox')).toHaveLength(2) // role + server
    expect(screen.getByText('Fast')).toBeInTheDocument()
    expect(screen.getByText('Standard')).toBeInTheDocument()
  })

  test('clicking a sortable column header toggles sort direction', () => {
    setup()
    const usernameHeader = screen.getByRole('columnheader', { name: /username/i })
    fireEvent.click(usernameHeader)
    fireEvent.click(usernameHeader)
    // No crash / still renders rows after toggling sort twice.
    expect(screen.getByText('alice')).toBeInTheDocument()
  })

  test('shows a "Storage details" toggle per row (quota editing now lives in the expanded panel)', () => {
    setup()
    expect(screen.getAllByTitle(/storage details/i)).toHaveLength(2)
  })

  test('edit button switches row to editing mode', () => {
    setup()
    fireEvent.click(screen.getAllByTitle(/edit username/i)[0])
    expect(screen.getByDisplayValue('alice')).toBeInTheDocument()
  })

  test('cancel button exits editing mode', () => {
    setup()
    fireEvent.click(screen.getAllByTitle(/edit username/i)[0])
    fireEvent.click(screen.getByTitle(/cancel/i))
    expect(screen.queryByDisplayValue('alice')).not.toBeInTheDocument()
    expect(screen.getByText('alice')).toBeInTheDocument()
  })

  test('confirm button disabled when edit value is fewer than 3 characters', () => {
    setup()
    fireEvent.click(screen.getAllByTitle(/edit username/i)[0])
    fireEvent.change(screen.getByDisplayValue('alice'), { target: { value: 'ab' } })
    expect(screen.getByTitle(/confirm/i)).toBeDisabled()
  })

  test('shows pagination controls with correct page count', () => {
    setup({ total: 50 })
    expect(screen.getByText(/page 1 of 2/i)).toBeInTheDocument()
  })

  test('clicking a username calls impersonate and navigates to /client', () => {
    setup()
    fireEvent.click(screen.getAllByTitle(/view files as this user/i)[0])
    expect(mockImpersonate).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice' }))
    expect(mockNavigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/client' }))
  })
})
