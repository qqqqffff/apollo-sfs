import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'

// mock-prefixed vars are hoisted safely by jest's babel transform
const mockNavigate = jest.fn()
const mockLogin = jest.fn()

jest.mock('@tanstack/react-router', () => {
  const R = require('react')
  return {
    createFileRoute: () => (opts: any) => ({ options: opts }),
    Link: ({ children, to, className }: any) =>
      R.createElement('a', { href: to, className }, children),
    useNavigate: () => mockNavigate,
  }
})

jest.mock('../../auth', () => ({
  useAuth: () => ({ login: mockLogin }),
}))

jest.mock('../../api/auth', () => ({
  forgotPassword: jest.fn().mockResolvedValue(undefined),
  resetPassword: jest.fn().mockResolvedValue(undefined),
}))

import { Route } from '../../routes/login'

const Page = Route.options.component as React.ComponentType

function fillAndSubmit(username: string, password: string) {
  const form = screen.getByRole('button', { name: /sign in/i }).closest('form')!
  fireEvent.change(form.querySelector('input[autocomplete="username"]')!, {
    target: { value: username },
  })
  fireEvent.change(form.querySelector('input[autocomplete="current-password"]')!, {
    target: { value: password },
  })
  fireEvent.submit(form)
}

describe('Login page (/login)', () => {
  beforeEach(() => {
    mockNavigate.mockReset()
    mockLogin.mockReset()
  })

  test('renders username and password inputs', () => {
    const { container } = render(<Page />)
    expect(container.querySelector('input[autocomplete="username"]')).toBeInTheDocument()
    expect(container.querySelector('input[autocomplete="current-password"]')).toBeInTheDocument()
  })

  test('renders sign-in submit button', () => {
    render(<Page />)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  test('shows heading', () => {
    render(<Page />)
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument()
  })

  test('calls login with entered credentials on submit', async () => {
    mockLogin.mockResolvedValue('admin')
    render(<Page />)
    await act(async () => fillAndSubmit('alice', 'secret'))
    expect(mockLogin).toHaveBeenCalledWith('alice', 'secret')
  })

  test('shows error message on failed login', async () => {
    mockLogin.mockResolvedValue('fail')
    render(<Page />)
    await act(async () => fillAndSubmit('alice', 'wrong'))
    expect(screen.getByText(/invalid username or password/i)).toBeInTheDocument()
  })

  test('navigates to /admin/users on admin login', async () => {
    mockLogin.mockResolvedValue('admin')
    render(<Page />)
    await act(async () => fillAndSubmit('admin', 'pass'))
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/admin/users' })
  })

  test('navigates to /client on client login', async () => {
    mockLogin.mockResolvedValue('client')
    render(<Page />)
    await act(async () => fillAndSubmit('user', 'pass'))
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/client' }),
    )
  })

  test('disables submit button while pending', async () => {
    // Never resolves so isPending stays true
    mockLogin.mockReturnValue(new Promise(() => {}))
    render(<Page />)
    act(() => fillAndSubmit('a', 'b'))
    expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled()
  })

  test('opens forgot-password modal', () => {
    render(<Page />)
    // The button is inside a <label>, so its accessible name comes from the label
    // rather than its own text — query by text content instead.
    fireEvent.click(screen.getByText('Forgot password?'))
    expect(screen.getByText(/reset your password/i)).toBeInTheDocument()
  })

  test('closes forgot-password modal via close button', () => {
    render(<Page />)
    fireEvent.click(screen.getByText('Forgot password?'))
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(screen.queryByText(/reset your password/i)).not.toBeInTheDocument()
  })

  test('closes forgot-password modal by clicking backdrop', () => {
    render(<Page />)
    fireEvent.click(screen.getByText('Forgot password?'))
    const backdrop = document.querySelector('.fixed.inset-0') as HTMLElement
    fireEvent.click(backdrop)
    expect(screen.queryByText(/reset your password/i)).not.toBeInTheDocument()
  })
})
