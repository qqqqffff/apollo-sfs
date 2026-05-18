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
  adminInterestInfiniteQueryOptions:  { queryKey: ['admin', 'interest'],          queryFn: jest.fn() },
  interestFormSettingsQueryOptions:    { queryKey: ['admin', 'interest', 'settings'], queryFn: jest.fn() },
  capacityQueryOptions:               { queryKey: ['admin', 'capacity'],           queryFn: jest.fn() },
  updateInterestFormSettings:          jest.fn(),
  provisionInterestSubmission:         jest.fn(),
}))

jest.mock('../../../api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor(msg: string, status = 400) { super(msg); this.status = status }
  },
}))

import { Route } from '../../../routes/_auth.admin/interest'
const Page = Route.options.component as React.ComponentType

const SUBMISSIONS = [
  { id: 's1', name: 'Alice',   email: 'alice@example.com', desired_storage_gb: 10, use_case: 'Backups',   created_at: '2024-01-01T00:00:00Z', provisioned_at: null },
  { id: 's2', name: 'Bob',     email: 'bob@example.com',   desired_storage_gb: 5,  use_case: 'Documents', created_at: '2024-01-02T00:00:00Z', provisioned_at: '2024-01-03T00:00:00Z' },
]

function setup(
  submissions = SUBMISSIONS,
  overrides: { isLoading?: boolean; error?: Error | null; dailyCap?: number } = {},
) {
  const { isLoading = false, error = null, dailyCap = 100 } = overrides
  mockInfiniteQuery.mockReturnValue({
    data: { pages: [{ items: submissions }] },
    isLoading,
    error,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(),
  })
  // useQuery is called twice: settings (queryKey[2]==='settings') then capacity
  mockQuery.mockImplementation((opts: any) =>
    opts?.queryKey?.[2] === 'settings'
      ? { data: { daily_cap: dailyCap } }
      : { data: null },
  )
  mockMutation.mockReturnValue({ mutate: jest.fn(), isPending: false })
  mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn() })
  return render(<Page />)
}

describe('Admin Interest submissions page', () => {
  beforeEach(() => {
    mockNotify.mockReset()
    mockQuery.mockReset()
  })

  test('renders Interest submissions heading', () => {
    setup()
    expect(screen.getByRole('heading', { name: /interest submissions/i })).toBeInTheDocument()
  })

  test('shows loading state', () => {
    setup([], { isLoading: true })
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  test('shows error state', () => {
    setup([], { error: new Error('fail') })
    expect(screen.getByText(/failed to load submissions/i)).toBeInTheDocument()
  })

  test('displays daily cap value', () => {
    setup([], { dailyCap: 50 })
    expect(screen.getByText('50')).toBeInTheDocument()
  })

  test('Edit cap button is present', () => {
    setup()
    expect(screen.getByRole('button', { name: /edit cap/i })).toBeInTheDocument()
  })

  test('clicking Edit cap shows an input field', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /edit cap/i }))
    expect(screen.getByPlaceholderText(/new cap/i)).toBeInTheDocument()
  })

  test('Cancel button hides the cap input', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /edit cap/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByPlaceholderText(/new cap/i)).not.toBeInTheDocument()
  })

  test('renders submission names and emails', () => {
    setup()
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('alice@example.com')).toBeInTheDocument()
    expect(screen.getByText('Bob')).toBeInTheDocument()
  })

  test('shows Pending badge for unprovisioned submissions', () => {
    setup()
    expect(screen.getByText('Pending')).toBeInTheDocument()
  })

  test('shows Provisioned badge for provisioned submissions', () => {
    setup()
    expect(screen.getByText('Provisioned')).toBeInTheDocument()
  })

  test('shows Provision button only for unprovisioned submissions', () => {
    setup()
    expect(screen.getAllByRole('button', { name: /provision/i })).toHaveLength(1)
  })

  test('shows empty state when no submissions', () => {
    setup([])
    expect(screen.getByText(/no submissions yet/i)).toBeInTheDocument()
  })

  test('clicking Provision shows quota picker', () => {
    setup([SUBMISSIONS[0]])
    fireEvent.click(screen.getByRole('button', { name: /provision/i }))
    expect(screen.getByText(/choose storage quota/i)).toBeInTheDocument()
  })

  test('quota picker Cancel hides the picker', () => {
    setup([SUBMISSIONS[0]])
    fireEvent.click(screen.getByRole('button', { name: /provision/i }))
    // There are two Cancel-like buttons now; the one in the quota picker
    const cancelBtn = screen.getAllByRole('button', { name: /cancel/i })[0]
    fireEvent.click(cancelBtn)
    expect(screen.queryByText(/choose storage quota/i)).not.toBeInTheDocument()
  })
})
