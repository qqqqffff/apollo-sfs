import React from 'react'
import { render, screen } from '@testing-library/react'
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

jest.mock('../../api/auth', () => ({
  register: jest.fn().mockResolvedValue(undefined),
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

  test('submit button is not disabled initially', () => {
    mockToken = 'invite-abc'
    renderPage()
    expect(screen.getByRole('button', { name: /create account/i })).not.toBeDisabled()
  })
})
