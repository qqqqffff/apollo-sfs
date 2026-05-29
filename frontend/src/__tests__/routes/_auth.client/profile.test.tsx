import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

jest.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: any) => ({ options: opts }),
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
  changePassword: jest.fn(),
  preferencesQueryOptions: { queryKey: ['preferences'], queryFn: jest.fn() },
  updatePreferences: jest.fn(),
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
  storage_used_bytes: 2 * GB,
  storage_quota_bytes: 10 * GB,
  created_at: '2024-01-01T00:00:00Z',
  last_seen_at: null,
}

function setup(user: typeof USER | null = USER, overrides: { isLoading?: boolean; isPending?: boolean } = {}) {
  const { isLoading = false, isPending = false } = overrides
  mockQuery.mockReturnValue({ data: user, isLoading })
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

  test('renders change password form fields', () => {
    setup()
    expect(screen.getByText(/current password/i)).toBeInTheDocument()
    expect(screen.getByText(/^new password$/i)).toBeInTheDocument()
    expect(screen.getByText(/^confirm new password$/i)).toBeInTheDocument()
  })

  test('Update password button is disabled with no input', () => {
    setup()
    expect(screen.getByRole('button', { name: /update password/i })).toBeDisabled()
  })

  test('shows password requirement checklist after focusing new-password field', () => {
    setup()
    const inputs = screen.getAllByDisplayValue('')
    fireEvent.focus(inputs[1]) // new password field
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument()
    expect(screen.getByText(/one uppercase letter/i)).toBeInTheDocument()
    expect(screen.getByText(/one number/i)).toBeInTheDocument()
    expect(screen.getByText(/one symbol/i)).toBeInTheDocument()
    expect(screen.getByText(/passwords match/i)).toBeInTheDocument()
  })

  test('shows Saving… label while pending', () => {
    setup(USER, { isPending: true })
    expect(screen.getByRole('button', { name: /saving/i })).toBeInTheDocument()
  })
})
