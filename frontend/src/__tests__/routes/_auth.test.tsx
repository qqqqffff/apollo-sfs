import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

const mockNavigate = jest.fn()
const mockLogoutMutate = jest.fn()

jest.mock('@tanstack/react-router', () => {
  const R = require('react')
  return {
    createFileRoute: () => (opts: any) => ({ options: opts }),
    Link: ({ children, to, className }: any) =>
      R.createElement('a', { href: to, className }, children),
    Outlet: () => R.createElement('div', { 'data-testid': 'outlet' }),
    useNavigate: () => mockNavigate,
    redirect: jest.fn(),
  }
})

const mockUseQuery = jest.fn()
const mockUseMutation = jest.fn()
const mockUseQueryClient = jest.fn()

jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQuery: (...args: any[]) => mockUseQuery(...args),
  useMutation: (...args: any[]) => mockUseMutation(...args),
  useQueryClient: () => mockUseQueryClient(),
}))

jest.mock('../../api/me', () => ({
  meQueryOptions: { queryKey: ['me'], queryFn: jest.fn() },
}))

jest.mock('../../api/auth', () => ({
  logout: jest.fn(),
}))

jest.mock('../../components/DeleteConfirmModal', () => ({
  clearSkipDeleteCookie: jest.fn(),
}))

const mockImpersonate = jest.fn()
const mockClearImpersonation = jest.fn()
let mockImpersonatedUser: any = null

jest.mock('../../context/ImpersonationContext', () => ({
  useImpersonation: () => ({
    impersonatedUser: mockImpersonatedUser,
    impersonate: mockImpersonate,
    clearImpersonation: mockClearImpersonation,
  }),
}))

jest.mock('../../context/NotificationContext', () => ({
  useNotification: () => ({ notify: jest.fn() }),
}))

jest.mock('../../api/admin', () => ({
  banUser: jest.fn(),
  suspendUser: jest.fn(),
  pardonUser: jest.fn(),
}))

jest.mock('../../components/BanSuspendModal', () => ({
  BanSuspendModal: () => null,
}))

import { Route } from '../../routes/_auth'

const Nav = Route.options.component as React.ComponentType

type UserPartial = { username?: string; is_admin?: boolean }

function renderNav(userOverrides: UserPartial = {}) {
  const user = userOverrides.username !== undefined ? {
    username: userOverrides.username,
    is_admin: userOverrides.is_admin ?? false,
  } : null

  mockUseQuery.mockReturnValue({ data: user })
  // _auth uses 4 mutations: logout, ban, suspend, pardon — return a stub for each call
  mockUseMutation.mockReturnValue({ mutate: mockLogoutMutate, isPending: false })
  mockUseQueryClient.mockReturnValue({ clear: jest.fn(), invalidateQueries: jest.fn() })

  return render(<Nav />)
}

describe('_auth layout nav', () => {
  beforeEach(() => {
    mockNavigate.mockReset()
    mockLogoutMutate.mockReset()
    mockImpersonate.mockReset()
    mockClearImpersonation.mockReset()
    mockImpersonatedUser = null
  })

  test('renders brand name', () => {
    renderNav({ username: 'alice' })
    expect(screen.getByText('Apollo SFS')).toBeInTheDocument()
  })

  test('renders Files and Favorites links', () => {
    renderNav({ username: 'alice' })
    expect(screen.getByRole('link', { name: 'Files' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Favorites' })).toBeInTheDocument()
  })

  test('admin nav links not shown for non-admin user', () => {
    renderNav({ username: 'alice', is_admin: false })
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Metrics' })).not.toBeInTheDocument()
  })

  test('admin nav links shown for admin user', () => {
    renderNav({ username: 'admin', is_admin: true })
    expect(screen.getByRole('link', { name: 'Users' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Invitations' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Interest' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Bans & Suspensions' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Metrics' })).toBeInTheDocument()
  })

  test('shows username as a profile link', () => {
    renderNav({ username: 'alice' })
    expect(screen.getByRole('link', { name: 'alice' })).toBeInTheDocument()
  })

  test('renders the Outlet placeholder', () => {
    renderNav({ username: 'alice' })
    expect(screen.getByTestId('outlet')).toBeInTheDocument()
  })

  test('mobile menu is closed by default', () => {
    renderNav({ username: 'alice' })
    // Mobile links exist only inside the dropdown; when closed the dropdown is absent
    const mobileLinks = screen.queryAllByRole('link', { name: 'Files' })
    // Desktop link always exists; mobile dropdown adds a second one only when open
    expect(mobileLinks).toHaveLength(1)
  })

  test('clicking mobile toggle opens the dropdown', () => {
    renderNav({ username: 'alice' })
    const toggle = screen.getByRole('button', { name: /toggle navigation/i })
    fireEvent.click(toggle)
    // Now both the desktop and mobile versions of Files are in the DOM
    expect(screen.getAllByRole('link', { name: 'Files' })).toHaveLength(2)
  })

  test('clicking mobile toggle again closes the dropdown', () => {
    renderNav({ username: 'alice' })
    const toggle = screen.getByRole('button', { name: /toggle navigation/i })
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(screen.getAllByRole('link', { name: 'Files' })).toHaveLength(1)
  })

  test('sign out button calls logout mutation', () => {
    renderNav({ username: 'alice' })
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
    expect(mockLogoutMutate).toHaveBeenCalledTimes(1)
  })

  test('impersonation badge not shown when no impersonated user', () => {
    renderNav({ username: 'alice' })
    expect(screen.queryByText('bob')).not.toBeInTheDocument()
  })

  test('impersonation badge shown when impersonating a user', () => {
    mockImpersonatedUser = { username: 'bob', email: 'bob@example.com' }
    renderNav({ username: 'alice' })
    expect(screen.getByText('bob')).toBeInTheDocument()
  })

  test('clicking impersonation badge calls clearImpersonation', () => {
    mockImpersonatedUser = { username: 'bob', email: 'bob@example.com' }
    renderNav({ username: 'alice' })
    fireEvent.click(screen.getByTitle(/exit impersonation/i))
    expect(mockClearImpersonation).toHaveBeenCalledTimes(1)
  })
})
