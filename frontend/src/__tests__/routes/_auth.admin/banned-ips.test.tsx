import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

jest.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: any) => ({ options: opts }),
}))

const mockInfiniteQuery = jest.fn()
const mockMutation = jest.fn()
const mockQueryClient = jest.fn()

jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useInfiniteQuery: (...args: any[]) => mockInfiniteQuery(...args),
  useMutation:      (...args: any[]) => mockMutation(...args),
  useQueryClient:   () => mockQueryClient(),
}))

const mockNotify = jest.fn()
jest.mock('../../../context/NotificationContext', () => ({
  useNotification: () => ({ notify: mockNotify }),
}))

jest.mock('../../../api/admin', () => ({
  listBannedIPs: jest.fn(),
  unbanIP:       jest.fn(),
  extendBan:     jest.fn(),
}))

import { Route } from '../../../routes/_auth.admin/banned-ips'
const Page = Route.options.component as React.ComponentType

const BANS = [
  { id: 'b1', ip: '1.2.3.4', country: 'US', city: 'New York', banned_at: new Date(Date.now() - 3600_000).toISOString(), unbanned_at: null,   ban_count: 1, jail: 'nginx-api-scan' },
  { id: 'b2', ip: '5.6.7.8', country: null, city: null,        banned_at: new Date(Date.now() - 7200_000).toISOString(), unbanned_at: new Date(Date.now() - 1800_000).toISOString(), ban_count: 3, jail: 'nginx-api-scan' },
]

function setup(bans = BANS, overrides: { isLoading?: boolean; error?: Error | null } = {}) {
  const { isLoading = false, error = null } = overrides
  mockInfiniteQuery.mockReturnValue({
    data: { pages: [{ items: bans }] },
    isLoading,
    error,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(),
  })
  mockMutation.mockReturnValue({ mutate: jest.fn(), isPending: false, variables: undefined })
  mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn() })
  return render(<Page />)
}

describe('Admin Banned IPs page', () => {
  beforeEach(() => mockNotify.mockReset())

  test('renders Banned IPs heading', () => {
    setup()
    expect(screen.getByRole('heading', { name: /banned ips/i })).toBeInTheDocument()
  })

  test('renders Active and All filter buttons', () => {
    setup()
    expect(screen.getByRole('button', { name: /^active$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^all$/i })).toBeInTheDocument()
  })

  test('shows loading state', () => {
    setup([], { isLoading: true })
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  test('shows error state', () => {
    setup([], { error: new Error('fail') })
    expect(screen.getByText(/failed to load banned ips/i)).toBeInTheDocument()
  })

  test('shows empty state for no active bans', () => {
    setup([])
    expect(screen.getByText(/no active bans/i)).toBeInTheDocument()
  })

  test('empty state message changes for "all" filter', () => {
    setup([])
    fireEvent.click(screen.getByRole('button', { name: /^all$/i }))
    expect(screen.getByText(/no ban records found/i)).toBeInTheDocument()
  })

  test('renders IP addresses in table', () => {
    setup()
    expect(screen.getByText('1.2.3.4')).toBeInTheDocument()
    expect(screen.getByText('5.6.7.8')).toBeInTheDocument()
  })

  test('shows location for bans with geo data', () => {
    setup()
    expect(screen.getByText(/New York.*US|US.*New York/)).toBeInTheDocument()
  })

  test('shows Unknown for bans without geo data', () => {
    setup()
    expect(screen.getByText('Unknown')).toBeInTheDocument()
  })

  test('Extend and Unban buttons for active bans', () => {
    setup([BANS[0]])
    expect(screen.getByRole('button', { name: /extend/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /unban/i })).toBeInTheDocument()
  })

  test('shows "Unbanned" text for inactive bans', () => {
    setup([BANS[1]])
    expect(screen.getByText('Unbanned')).toBeInTheDocument()
  })

  test('count badge shows when bans are present', () => {
    setup()
    expect(screen.getByText(/shown/)).toBeInTheDocument()
  })

  test('shows Load more button when hasNextPage', () => {
    mockInfiniteQuery.mockReturnValue({
      data: { pages: [{ items: BANS }] },
      isLoading: false, error: null, hasNextPage: true, isFetchingNextPage: false, fetchNextPage: jest.fn(),
    })
    mockMutation.mockReturnValue({ mutate: jest.fn(), isPending: false, variables: undefined })
    mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn() })
    render(<Page />)
    expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument()
  })
})
