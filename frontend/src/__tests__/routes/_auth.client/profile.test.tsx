import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

jest.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: any) => ({ options: opts }),
  useNavigate: () => jest.fn(),
}))

const mockQuery = jest.fn()
const mockMutation = jest.fn()

jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQuery:    (...args: any[]) => mockQuery(...args),
  useMutation: (...args: any[]) => mockMutation(...args),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}))

jest.mock('../../../api/me', () => ({
  meQueryOptions: { queryKey: ['me'], queryFn: jest.fn() },
  updateUsername: jest.fn(),
  preferencesQueryOptions: { queryKey: ['preferences'], queryFn: jest.fn() },
  updatePreferences: jest.fn(),
  updateStorageUIPreferences: jest.fn(),
  updateSandboxPayments: jest.fn(),
  unlinkProvider: jest.fn(),
}))

jest.mock('../../../api/auth', () => ({
  logout: jest.fn(),
}))

jest.mock('../../../context/NotificationContext', () => ({
  useNotification: () => ({ notify: jest.fn() }),
}))

jest.mock('../../../api/folders', () => ({
  listRoot: jest.fn(),
}))

jest.mock('../../../api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor(msg: string, status = 400) { super(msg); this.status = status }
  },
}))

import { Route } from '../../../routes/_auth.client/profile'
const Page = Route.options.component as React.ComponentType

const GB = 1024 ** 3

const USER = {
  username: 'alice',
  email: 'alice@example.com',
  is_admin: false,
  is_premium: false,
  premium_granted_at: null,
  sandbox_payments_enabled: false,
  linked_providers: [] as string[],
  storage_used_bytes: 2 * GB,
  storage_quota_bytes: 10 * GB,
  created_at: '2024-01-01T00:00:00Z',
  last_seen_at: null,
}

function setup(user: typeof USER | null = USER, overrides: { isLoading?: boolean; isPending?: boolean } = {}) {
  const { isLoading = false, isPending = false } = overrides
  // The page fires several queries (me, storage breakdown/my-servers, expansion
  // requests, preferences, file-server links). Branch by key so array-shaped
  // queries (my-servers) get an array, not the user object.
  mockQuery.mockImplementation((opts: { queryKey?: readonly unknown[] }) => {
    const key = opts?.queryKey ?? []
    if (key[0] === 'me') return { data: user, isLoading }
    if (key[1] === 'my-servers') return { data: [] }
    return { data: undefined }
  })
  mockMutation.mockReturnValue({ mutate: jest.fn(), isPending })
  return render(<Page />)
}

describe('Client Profile page', () => {
  test('shows loading state', () => {
    setup(null, { isLoading: true })
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  test('renders Profile heading', () => {
    setup()
    expect(screen.getByRole('heading', { name: /^profile$/i })).toBeInTheDocument()
  })

  test('shows username and email', () => {
    setup()
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('alice@example.com')).toBeInTheDocument()
  })

  test('shows account type as User for non-admin', () => {
    setup()
    expect(screen.getByText('User')).toBeInTheDocument()
  })

  test('shows account type as Admin for admin users', () => {
    setup({ ...USER, is_admin: true })
    expect(screen.getByText('Admin')).toBeInTheDocument()
  })

  test('shows storage usage', () => {
    setup()
    // Rendered as "2.00 GB / 10.00 GB" in a single element
    expect(screen.getByText(/2\.00 GB/)).toBeInTheDocument()
    expect(screen.getByText(/10\.00 GB/)).toBeInTheDocument()
  })

  test('shows percentage used', () => {
    setup()
    expect(screen.getByText(/20\.0%\s*used/i)).toBeInTheDocument()
  })

  test('shows a Change password button linking to the separate 2FA page', () => {
    setup()
    // The inline password form was replaced by a link to /client/change-password
    // (which requires an emailed two-factor code).
    expect(screen.getByRole('button', { name: /change password/i })).toBeInTheDocument()
    expect(screen.getByText(/one-time code sent to your email/i)).toBeInTheDocument()
  })

  test('allows editing the username inline', () => {
    setup()
    fireEvent.click(screen.getByTitle(/edit username/i))
    // The current username becomes editable in a text input.
    expect(screen.getByDisplayValue('alice')).toBeInTheDocument()
    expect(screen.getByText(/signs you out/i)).toBeInTheDocument()
  })
})
