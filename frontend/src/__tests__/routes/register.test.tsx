import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// mock-prefixed var is hoisted safely
let mockToken = ''

jest.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: any) => ({
    options: opts,
    useLoaderData: () => ({ token: mockToken }),
  }),
}))

const mockValidateInviteToken = jest.fn()

jest.mock('../../api/auth', () => ({
  register: jest.fn().mockResolvedValue(undefined),
  validateInviteToken: (...args: any[]) => mockValidateInviteToken(...args),
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
})
