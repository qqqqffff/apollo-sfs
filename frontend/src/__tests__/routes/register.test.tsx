import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// mock-prefixed var is hoisted safely
let mockToken = ''

jest.mock('@tanstack/react-router', () => {
  const R = require('react')
  return {
    createFileRoute: () => (opts: any) => ({
      options: opts,
      useLoaderData: () => ({ token: mockToken }),
    }),
    useNavigate: () => jest.fn(),
    Link: ({ children, to, className }: any) =>
      R.createElement('a', { href: to, className }, children),
  }
})

const mockValidateInviteToken = jest.fn()
const mockRegister = jest.fn().mockResolvedValue(undefined)
const mockLogout = jest.fn().mockResolvedValue(undefined)

jest.mock('../../api/auth', () => ({
  register: (...args: any[]) => mockRegister(...args),
  validateInviteToken: (...args: any[]) => mockValidateInviteToken(...args),
  logout: (...args: any[]) => mockLogout(...args),
}))

// Defaults to signed-out so pre-existing tests exercise the normal form;
// individual tests override this to exercise the "already signed in" gate.
let mockAuthState: { isAuthenticated: boolean; isLoading: boolean; user: { username: string } | null } = {
  isAuthenticated: false,
  isLoading: false,
  user: null,
}

jest.mock('../../auth', () => ({
  useAuth: () => mockAuthState,
}))

// Defaults to no Turnstile key (captcha not required) so pre-existing tests
// that don't care about the captcha keep working unchanged; individual tests
// override this to exercise the captcha-required path.
const mockGetPublicConfig = jest.fn()

jest.mock('../../api/interest', () => ({
  publicConfigQueryOptions: {
    queryKey: ['public', 'config'],
    queryFn: (...args: any[]) => mockGetPublicConfig(...args),
  },
}))

jest.mock('../../api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor(msg: string, status = 400) {
      super(msg)
      this.status = status
    }
  },
}))

// Render Turnstile as a button so tests can simulate captcha completion.
// Uses forwardRef to silence the "function components cannot be given refs" warning
// since register.tsx passes a ref to the widget.
jest.mock('@marsidev/react-turnstile', () => {
  const R = require('react')
  return {
    Turnstile: R.forwardRef(({ onSuccess }: { onSuccess: (t: string) => void }, _ref: unknown) =>
      R.createElement('button', {
        type: 'button',
        'data-testid': 'turnstile',
        onClick: () => onSuccess('mock-captcha-token'),
      }, 'Complete captcha'),
    ),
  }
})

import { Route } from '../../routes/register'

const Page = Route.options.component as React.ComponentType

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  )
}

describe('Register page (/register)', () => {
  beforeEach(() => {
    mockValidateInviteToken.mockResolvedValue({
      email: 'invited@example.com',
      invited_by_user_id: 'uid-1',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      grant_admin: false,
    })
    mockGetPublicConfig.mockReset().mockResolvedValue({})
    mockRegister.mockClear()
    mockLogout.mockClear()
    mockAuthState = { isAuthenticated: false, isLoading: false, user: null }
  })

  test('shows invalid-link message when token is empty', () => {
    mockToken = ''
    renderPage()
    expect(screen.getByText(/invalid or missing invite link/i)).toBeInTheDocument()
  })

  test('shows form when a token is provided', () => {
    mockToken = 'invite-abc'
    renderPage()
    expect(screen.getByRole('heading', { name: /create account/i })).toBeInTheDocument()
  })

  test('renders username, email, and password fields', () => {
    mockToken = 'invite-abc'
    const { container } = renderPage()
    expect(container.querySelector('input[autocomplete="username"]')).toBeInTheDocument()
    expect(container.querySelector('input[autocomplete="email"]')).toBeInTheDocument()
    expect(container.querySelector('input[autocomplete="new-password"]')).toBeInTheDocument()
  })

  test('renders create-account submit button', () => {
    mockToken = 'invite-abc'
    renderPage()
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument()
  })

  test('submit button is disabled initially because terms are not accepted', () => {
    mockToken = 'invite-abc'
    renderPage()
    expect(screen.getByRole('button', { name: /create account/i })).toBeDisabled()
  })

  test('submit button enables after accepting terms', () => {
    mockToken = 'invite-abc'
    renderPage()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: /create account/i })).not.toBeDisabled()
  })

  test('renders terms of service checkbox unchecked by default', () => {
    mockToken = 'invite-abc'
    renderPage()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  test('renders Terms of Service link button', () => {
    mockToken = 'invite-abc'
    renderPage()
    expect(screen.getByRole('button', { name: /terms of service/i })).toBeInTheDocument()
  })

  test('opens terms modal when Terms of Service link is clicked', () => {
    mockToken = 'invite-abc'
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /terms of service/i }))
    expect(screen.getByRole('heading', { name: /terms of service/i })).toBeInTheDocument()
  })

  test('closes terms modal when Close button is clicked', () => {
    mockToken = 'invite-abc'
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /terms of service/i }))
    const closeButtons = screen.getAllByRole('button', { name: /^close$/i })
    fireEvent.click(closeButtons[closeButtons.length - 1])
    expect(screen.queryByRole('heading', { name: /terms of service/i })).not.toBeInTheDocument()
  })

  test('closes terms modal on Escape key', () => {
    mockToken = 'invite-abc'
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /terms of service/i }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('heading', { name: /terms of service/i })).not.toBeInTheDocument()
  })

  test('shows Admin badge when invite has grant_admin=true', async () => {
    mockValidateInviteToken.mockResolvedValue({
      email: 'admin@example.com',
      invited_by_user_id: 'uid-1',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      grant_admin: true,
    })
    mockToken = 'admin-invite'
    renderPage()
    await waitFor(() => expect(screen.getByText('Admin')).toBeInTheDocument())
  })

  test('does not show Admin badge when invite has grant_admin=false', async () => {
    mockToken = 'invite-abc'
    renderPage()
    await waitFor(() => expect(mockValidateInviteToken).toHaveBeenCalled())
    expect(screen.queryByText('Admin')).not.toBeInTheDocument()
  })

  test('autofills the email field from the invite token and locks it read-only', async () => {
    mockToken = 'invite-abc'
    const { container } = renderPage()
    await waitFor(() => expect(mockValidateInviteToken).toHaveBeenCalled())
    const emailInput = container.querySelector('input[autocomplete="email"]') as HTMLInputElement
    await waitFor(() => expect(emailInput.value).toBe('invited@example.com'))
    expect(emailInput).toHaveAttribute('readonly')
    fireEvent.change(emailInput, { target: { value: 'someone-else@example.com' } })
    expect(emailInput.value).toBe('invited@example.com')
  })

  test('shows a disclaimer linking to support for a wrong invite email', async () => {
    mockToken = 'invite-abc'
    renderPage()
    const link = await screen.findByRole('link', { name: /apollo sfs support/i })
    expect(link).toHaveAttribute('href', 'mailto:support@apollo-sfs.com')
  })

  test('password requirements checklist is hidden until the field is focused', () => {
    mockToken = 'invite-abc'
    const { container } = renderPage()
    expect(screen.queryByText(/at least 8 characters/i)).not.toBeInTheDocument()
    const passwordInput = container.querySelector('input[autocomplete="new-password"]') as HTMLInputElement
    fireEvent.focus(passwordInput)
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument()
  })

  test('password requirements checklist hides again on blur', () => {
    mockToken = 'invite-abc'
    const { container } = renderPage()
    const passwordInput = container.querySelector('input[autocomplete="new-password"]') as HTMLInputElement
    fireEvent.focus(passwordInput)
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument()
    fireEvent.blur(passwordInput)
    expect(screen.queryByText(/at least 8 characters/i)).not.toBeInTheDocument()
  })

  test('password requirement items check off as the typed password satisfies them', () => {
    mockToken = 'invite-abc'
    const { container } = renderPage()
    const passwordInput = container.querySelector('input[autocomplete="new-password"]') as HTMLInputElement
    fireEvent.focus(passwordInput)

    const uppercaseItem = () => screen.getByText(/one uppercase letter/i).closest('li')
    expect(uppercaseItem()).toHaveClass('text-red-500')

    fireEvent.change(passwordInput, { target: { value: 'Abcdefg1!' } })
    expect(uppercaseItem()).toHaveClass('text-green-600')
  })

  test('submit stays disabled until the captcha is completed when Turnstile is configured', async () => {
    mockGetPublicConfig.mockResolvedValue({ turnstile_site_key: 'test-site-key' })
    mockToken = 'invite-abc'
    renderPage()
    fireEvent.click(screen.getByRole('checkbox'))

    // Wait for the config fetch (and thus the Turnstile widget) to resolve
    // before asserting on the disabled state, so the check isn't racing the
    // async config query.
    const turnstile = await screen.findByTestId('turnstile')
    expect(screen.getByRole('button', { name: /create account/i })).toBeDisabled()

    fireEvent.click(turnstile)
    await waitFor(() => expect(screen.getByRole('button', { name: /create account/i })).not.toBeDisabled())
  })

  test('submits the completed captcha token to register()', async () => {
    mockGetPublicConfig.mockResolvedValue({ turnstile_site_key: 'test-site-key' })
    mockToken = 'invite-abc'
    const { container } = renderPage()
    fireEvent.change(container.querySelector('input[autocomplete="username"]') as HTMLInputElement, { target: { value: 'alice' } })
    fireEvent.change(container.querySelector('input[autocomplete="new-password"]') as HTMLInputElement, { target: { value: 'Abcdefg1!' } })
    fireEvent.click(screen.getByRole('checkbox'))

    const turnstile = await screen.findByTestId('turnstile')
    fireEvent.click(turnstile)

    const submitButton = await waitFor(() => {
      const btn = screen.getByRole('button', { name: /create account/i })
      expect(btn).not.toBeDisabled()
      return btn
    })
    fireEvent.click(submitButton)

    await waitFor(() => expect(mockRegister).toHaveBeenCalledWith(
      'alice', 'invited@example.com', 'Abcdefg1!', 'invite-abc', 'mock-captcha-token',
    ))
  })

  test('shows an already-signed-in notice instead of the form when a session is active', () => {
    mockToken = 'invite-abc'
    mockAuthState = { isAuthenticated: true, isLoading: false, user: { username: 'bob' } }
    renderPage()
    expect(screen.getByText(/already signed in/i)).toBeInTheDocument()
    expect(screen.getByText(/signed in as/i)).toHaveTextContent('bob')
    expect(screen.queryByRole('heading', { name: /create account/i })).not.toBeInTheDocument()
  })

  test('signing out from the already-signed-in notice calls logout()', async () => {
    mockToken = 'invite-abc'
    mockAuthState = { isAuthenticated: true, isLoading: false, user: { username: 'bob' } }
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /sign out and continue/i }))
    await waitFor(() => expect(mockLogout).toHaveBeenCalled())
  })
})
