import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const mockNavigate = jest.fn()
let mockSearch: { token?: string } = { token: 'reset-tok' }

jest.mock('@tanstack/react-router', () => {
  const R = require('react')
  return {
    createFileRoute: () => (opts: any) => ({ options: opts }),
    Link: ({ children, to }: any) => R.createElement('a', { href: to }, children),
    useNavigate: () => mockNavigate,
    useSearch: () => mockSearch,
  }
})

jest.mock('../../api/auth', () => ({
  resetPassword: jest.fn().mockResolvedValue({ message: 'password updated successfully' }),
}))

import { resetPassword } from '../../api/auth'
import { Route } from '../../routes/reset-password'

const Page = Route.options.component as React.ComponentType

function fillForm(password: string, confirm = password) {
  const form = screen.getByRole('button', { name: /update password/i }).closest('form')!
  const inputs = form.querySelectorAll('input[autocomplete="new-password"]')
  fireEvent.change(inputs[0], { target: { value: password } })
  fireEvent.change(inputs[1], { target: { value: confirm } })
  return form
}

const VALID = 'Sup3rSecret!pw'

describe('Reset password page (/reset-password)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearch = { token: 'reset-tok' }
  })

  test('submits the token from the emailed link with the new password', async () => {
    render(<Page />)
    fireEvent.submit(fillForm(VALID))
    await waitFor(() => expect(resetPassword).toHaveBeenCalledWith('reset-tok', VALID))
    expect(await screen.findByText(/password updated/i)).toBeInTheDocument()
  })

  test('will not submit when the two passwords differ', async () => {
    render(<Page />)
    fireEvent.submit(fillForm(VALID, `${VALID}x`))
    expect(await screen.findByText(/passwords do not match/i)).toBeInTheDocument()
    expect(resetPassword).not.toHaveBeenCalled()
  })

  // The realm rejects anything weaker, so the requirements are shown here rather
  // than surfacing as an opaque failure from Keycloak. The checklist comes from
  // utils/passwordPolicy, shared with /register and the change-password page.
  test('will not submit a password that fails the realm policy', async () => {
    render(<Page />)
    fireEvent.submit(fillForm('alllowercase'))
    expect(await screen.findByText(/every password requirement/i)).toBeInTheDocument()
    expect(resetPassword).not.toHaveBeenCalled()
    expect(screen.getByText(/one uppercase letter/i)).toBeInTheDocument()
  })

  test('explains an expired or reused link instead of failing silently', async () => {
    ;(resetPassword as jest.Mock).mockRejectedValueOnce(new Error('invalid'))
    render(<Page />)
    fireEvent.submit(fillForm(VALID))
    expect(await screen.findByText(/invalid or has expired/i)).toBeInTheDocument()
  })

  test('offers a way back when the link carries no token', () => {
    mockSearch = {}
    render(<Page />)
    expect(screen.getByText(/reset link incomplete/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /update password/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /back to sign in/i }))
    expect(mockNavigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/login' }))
  })
})
