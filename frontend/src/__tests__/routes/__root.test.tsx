import React from 'react'
import { render, screen, act } from '@testing-library/react'
import '@testing-library/jest-dom'

// ── Router mock ───────────────────────────────────────────────────────────────

const mockNavigate = jest.fn()

jest.mock('@tanstack/react-router', () => {
  const R = require('react')
  return {
    createRootRouteWithContext: () => (opts: any) => ({ options: opts }),
    Link: ({ children, to, className }: any) =>
      R.createElement('a', { href: to, className }, children),
    Outlet: () => R.createElement('div', { 'data-testid': 'outlet' }),
    useNavigate: () => mockNavigate,
  }
})

// ── React Query mock ──────────────────────────────────────────────────────────

const mockQueryClear = jest.fn()
const mockUseQuery   = jest.fn()

jest.mock('@tanstack/react-query', () => {
  return {
    useQuery:       (...args: any[]) => mockUseQuery(...args),
    useQueryClient: () => ({ clear: mockQueryClear, fetchQuery: jest.fn(), invalidateQueries: jest.fn(), setQueryData: jest.fn() }),
    QueryClient:    jest.fn(),
  }
})

// ── API mocks ─────────────────────────────────────────────────────────────────

jest.mock('../../api/me', () => ({
  meQueryOptions: { queryKey: ['me'], queryFn: jest.fn() },
  getMe: jest.fn(),
}))

jest.mock('../../api/auth', () => ({
  login:  jest.fn(),
  logout: jest.fn(),
}))

jest.mock('../../components/DeleteConfirmModal', () => ({
  clearSkipDeleteCookie: jest.fn(),
}))

jest.mock('../../components/AppIcon', () => ({
  AppIcon: ({ size }: { size: number }) => <svg data-testid="app-icon" width={size} />,
}))

const mockNotify = jest.fn()

jest.mock('../../context/NotificationContext', () => {
  const R = require('react')
  return {
    NotificationProvider: ({ children }: any) => R.createElement(R.Fragment, null, children),
    useNotification: () => ({ notify: mockNotify }),
  }
})

jest.mock('../../components/NotificationBanner', () => ({
  NotificationBanner: () => <div data-testid="notification-banner" />,
}))

import { clearSkipDeleteCookie } from '../../components/DeleteConfirmModal'
const mockClearSkipDeleteCookie = clearSkipDeleteCookie as jest.Mock

// ── Import after mocks ────────────────────────────────────────────────────────

import { Route } from '../../routes/__root'

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderRoot(isAuthenticated: boolean) {
  mockUseQuery.mockReturnValue({
    data: isAuthenticated ? { id: 'u1', username: 'alice', is_admin: false } : undefined,
    isLoading: false,
  })
  const Component = Route.options.component as React.ComponentType
  return render(<Component />)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockNavigate.mockReset()
  mockQueryClear.mockReset()
  mockClearSkipDeleteCookie.mockReset()
  mockNotify.mockReset()
  Object.defineProperty(window, 'location', {
    value: { pathname: '/' },
    writable: true,
  })
})

describe('Root — unauthenticated', () => {
  it('renders the public header when not authenticated', () => {
    renderRoot(false)
    expect(screen.getByText('Apollo SFS')).toBeInTheDocument()
  })

  it('renders the app icon in the header', () => {
    renderRoot(false)
    expect(screen.getByTestId('app-icon')).toBeInTheDocument()
  })

  it('renders the About nav link', () => {
    renderRoot(false)
    expect(screen.getByRole('link', { name: /about/i })).toHaveAttribute('href', '/about')
  })

  it('renders the Request access nav link', () => {
    renderRoot(false)
    expect(screen.getByRole('link', { name: /request access/i })).toHaveAttribute('href', '/interest')
  })

  it('renders the Sign in nav link', () => {
    renderRoot(false)
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login')
  })

  it('renders the Outlet', () => {
    renderRoot(false)
    expect(screen.getByTestId('outlet')).toBeInTheDocument()
  })

  it('renders the NotificationBanner', () => {
    renderRoot(false)
    expect(screen.getByTestId('notification-banner')).toBeInTheDocument()
  })
})

describe('Root — authenticated', () => {
  it('does not render the public header when authenticated', () => {
    renderRoot(true)
    expect(screen.queryByText('Apollo SFS')).not.toBeInTheDocument()
  })

  it('still renders the Outlet when authenticated', () => {
    renderRoot(true)
    expect(screen.getByTestId('outlet')).toBeInTheDocument()
  })
})

describe('Root — session expired handler', () => {
  it('navigates to /login when session-expired event fires', () => {
    renderRoot(false)
    act(() => {
      window.dispatchEvent(new CustomEvent('apollo:session-expired'))
    })
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' })
  })

  it('clears the query client cache on session expiry', () => {
    renderRoot(false)
    act(() => {
      window.dispatchEvent(new CustomEvent('apollo:session-expired'))
    })
    expect(mockQueryClear).toHaveBeenCalled()
  })

  it('clears the skip-delete cookie on session expiry', () => {
    renderRoot(false)
    act(() => {
      window.dispatchEvent(new CustomEvent('apollo:session-expired'))
    })
    expect(mockClearSkipDeleteCookie).toHaveBeenCalled()
  })

  it('shows a session-expired error notification', () => {
    renderRoot(false)
    act(() => {
      window.dispatchEvent(new CustomEvent('apollo:session-expired'))
    })
    expect(mockNotify).toHaveBeenCalledWith('error', expect.stringMatching(/session.*expired/i))
  })

  it('does not navigate when already on /login', () => {
    Object.defineProperty(window, 'location', { value: { pathname: '/login' }, writable: true })
    renderRoot(false)
    act(() => {
      window.dispatchEvent(new CustomEvent('apollo:session-expired'))
    })
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('does not show a notification when already on /login', () => {
    Object.defineProperty(window, 'location', { value: { pathname: '/login' }, writable: true })
    renderRoot(false)
    act(() => {
      window.dispatchEvent(new CustomEvent('apollo:session-expired'))
    })
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('removes the session-expired listener on unmount', () => {
    const { unmount } = renderRoot(false)
    unmount()
    act(() => {
      window.dispatchEvent(new CustomEvent('apollo:session-expired'))
    })
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})

describe('Root — notFoundComponent', () => {
  it('exports a notFoundComponent', () => {
    expect(typeof Route.options.notFoundComponent).toBe('function')
  })

  it('notFoundComponent renders "Page not found"', () => {
    const NotFound = Route.options.notFoundComponent as React.ComponentType
    render(<NotFound />)
    expect(screen.getByText('Page not found')).toBeInTheDocument()
  })

  it('notFoundComponent renders a Return home link', () => {
    const NotFound = Route.options.notFoundComponent as React.ComponentType
    render(<NotFound />)
    expect(screen.getByRole('link', { name: /return home/i })).toHaveAttribute('href', '/')
  })
})
