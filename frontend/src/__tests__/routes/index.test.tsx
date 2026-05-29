import React from 'react'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

jest.mock('@tanstack/react-router', () => {
  const R = require('react')
  return {
    createFileRoute: () => (opts: any) => ({ options: opts }),
    Link: ({ children, to, className }: any) =>
      R.createElement('a', { href: to, className }, children),
  }
})

import { Route } from '../../routes/index'

const Page = Route.options.component as React.ComponentType

describe('Landing page (/)', () => {
  test('renders hero heading', () => {
    render(<Page />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      /Your files, on your hardware/i,
    )
  })

  test('renders sign-in link pointing to /login', () => {
    render(<Page />)
    const link = screen.getByRole('link', { name: /sign in to your account/i })
    expect(link).toHaveAttribute('href', '/login')
  })

  test('renders all six feature card titles', () => {
    render(<Page />)
    const titles = [
      'Double-encrypted at rest',
      'Folder hierarchy',
      'In-browser previews',
      'Favourites',
      'Invite-only access',
      'Admin dashboard',
    ]
    titles.forEach((t) => expect(screen.getByText(t)).toBeInTheDocument())
  })

  test('renders the about section', () => {
    render(<Page />)
    expect(screen.getByText('Apollo Secure File Storage')).toBeInTheDocument()
  })

  test('renders footer', () => {
    render(<Page />)
    expect(screen.getByText(/Apollo SFS — Apollo Software Services/i)).toBeInTheDocument()
  })
})
