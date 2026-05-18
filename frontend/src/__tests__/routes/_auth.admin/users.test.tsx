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
  adminUsersInfiniteQueryOptions: { queryKey: ['admin', 'users'], queryFn: jest.fn() },
  updateUserQuota: jest.fn(),
  updateUsername: jest.fn(),
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

const GB = 1024 ** 3

const USERS = [
  { username: 'alice', email: 'alice@example.com', storage_used_bytes: 1 * GB, storage_quota_bytes: 10 * GB, is_admin: false, last_seen_at: null },
  { username: 'bob',   email: 'bob@example.com',   storage_used_bytes: 2 * GB, storage_quota_bytes: 20 * GB, is_admin: true,  last_seen_at: null },
]

function setup(overrides: { isLoading?: boolean; error?: Error | null; users?: typeof USERS; hasNextPage?: boolean } = {}) {
  const { isLoading = false, error = null, users = USERS, hasNextPage = false } = overrides
  mockInfiniteQuery.mockReturnValue({
    data: users ? { pages: [{ items: users }] } : null,
    isLoading,
    error,
    hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(),
  })
  mockQuery.mockReturnValue({ data: { username: 'alice' } })
  mockMutation.mockReturnValue({ mutate: jest.fn(), isPending: false, variables: undefined })
  mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn() })
  window.prompt = jest.fn().mockReturnValue(null)
  return render(<Page />)
}

describe('Admin Users page', () => {
  beforeEach(() => mockNotify.mockReset())

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

  test('shows quota in GB for each user', () => {
    setup()
    expect(screen.getByText('10 GB')).toBeInTheDocument()
    expect(screen.getByText('20 GB')).toBeInTheDocument()
  })

  test('shows "Set quota" buttons', () => {
    setup()
    expect(screen.getAllByRole('button', { name: /set quota/i })).toHaveLength(2)
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

  test('shows "Load more" button when hasNextPage', () => {
    setup({ hasNextPage: true })
    expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument()
  })

  test('does not show "Load more" when no next page', () => {
    setup()
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
  })
})
