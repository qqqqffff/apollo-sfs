import React from 'react'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

jest.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: any) => ({ options: opts }),
}))

import { Route } from '../../routes/about'

const Page = Route.options.component as React.ComponentType

describe('About page (/about)', () => {
  test('renders name heading', () => {
    render(<Page />)
    expect(screen.getByRole('heading', { name: /Apollinaris Rowe/i })).toBeInTheDocument()
  })

  test('renders Experience section', () => {
    render(<Page />)
    expect(screen.getByText('Experience')).toBeInTheDocument()
  })

  test('renders Education section', () => {
    render(<Page />)
    expect(screen.getByText('Education')).toBeInTheDocument()
  })

  test('renders experience institution cards', () => {
    render(<Page />)
    expect(screen.getByText('Liberty Mutual Insurance')).toBeInTheDocument()
    expect(screen.getByText('Apollo Software Services')).toBeInTheDocument()
    expect(screen.getByText('James French Photography')).toBeInTheDocument()
  })

  test('renders education card', () => {
    render(<Page />)
    expect(screen.getByText('Worcester Polytechnic Institute')).toBeInTheDocument()
  })

  test('renders LinkedIn and GitHub social links', () => {
    render(<Page />)
    expect(screen.getByRole('link', { name: /linkedin/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /github/i })).toBeInTheDocument()
  })

  test('shows GPA in education card', () => {
    render(<Page />)
    expect(screen.getByText(/GPA: 3\.7/)).toBeInTheDocument()
  })
})
