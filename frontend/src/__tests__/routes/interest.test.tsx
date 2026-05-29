import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'

jest.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: any) => ({ options: opts }),
}))

const mockMutate = jest.fn()
const mockUseQuery = jest.fn()
const mockUseMutation = jest.fn()

jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQuery: (...args: any[]) => mockUseQuery(...args),
  useMutation: (...args: any[]) => mockUseMutation(...args),
}))

jest.mock('../../api/interest', () => ({
  publicConfigQueryOptions: { queryKey: ['public', 'config'], queryFn: jest.fn() },
  submitInterestForm: jest.fn(),
}))

jest.mock('../../api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor(msg: string, status = 400) { super(msg); this.status = status }
  },
}))

// Render Turnstile as a button so tests can simulate captcha completion.
// Uses forwardRef to silence the "function components cannot be given refs" warning
// since interest.tsx passes a ref to the widget.
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

import { Route } from '../../routes/interest'

const Page = Route.options.component as React.ComponentType

function renderPage(config: Record<string, unknown> | null = null) {
  mockUseQuery.mockReturnValue({ data: config })
  mockUseMutation.mockReturnValue({ mutate: mockMutate, isPending: false })
  return render(<Page />)
}

describe('Interest / request-access page (/interest)', () => {
  beforeEach(() => {
    mockMutate.mockReset()
    mockUseQuery.mockReset()
    mockUseMutation.mockReset()
  })

  test('renders the Request access heading', () => {
    renderPage()
    expect(screen.getByRole('heading', { name: /request access/i })).toBeInTheDocument()
  })

  test('renders Full name, Email address, and Reason fields', () => {
    renderPage()
    expect(screen.getByLabelText(/full name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/reason \/ use case/i)).toBeInTheDocument()
  })

  test('renders the storage slider with default 10 GB label', () => {
    renderPage()
    // The preset button for 10 GB is also in the DOM, so scope to the label span
    expect(screen.getByText('10 GB', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByRole('slider')).toHaveValue('10')
  })

  test('storage preset buttons update the displayed value', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '25 GB' }))
    expect(screen.getByText('25 GB', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByRole('slider')).toHaveValue('25')
  })

  test('moving the slider updates the displayed GB label', () => {
    renderPage()
    fireEvent.change(screen.getByRole('slider'), { target: { value: '50' } })
    expect(screen.getByText('50 GB', { selector: 'span' })).toBeInTheDocument()
  })

  test('submit button is disabled when no captcha token (no widget rendered)', () => {
    // No config → no Turnstile widget → captchaToken stays null
    renderPage(null)
    expect(screen.getByRole('button', { name: /submit request/i })).toBeDisabled()
  })

  test('shows captcha error when form submitted without token', () => {
    renderPage(null)
    fireEvent.submit(screen.getByRole('button', { name: /submit request/i }).closest('form')!)
    expect(screen.getByText(/please complete the security check/i)).toBeInTheDocument()
  })

  test('Turnstile widget renders when config has a site key', () => {
    renderPage({ turnstile_site_key: 'key123' })
    expect(screen.getByTestId('turnstile')).toBeInTheDocument()
  })

  test('completing captcha enables the submit button', () => {
    renderPage({ turnstile_site_key: 'key123' })
    fireEvent.click(screen.getByTestId('turnstile'))
    expect(screen.getByRole('button', { name: /submit request/i })).not.toBeDisabled()
  })

  test('submitting with a captcha token calls mutate', () => {
    renderPage({ turnstile_site_key: 'key123' })
    fireEvent.click(screen.getByTestId('turnstile'))
    fireEvent.submit(screen.getByRole('button', { name: /submit request/i }).closest('form')!)
    expect(mockMutate).toHaveBeenCalledTimes(1)
  })

  test('shows Submitting… label while mutation is pending', () => {
    mockUseQuery.mockReturnValue({ data: { turnstile_site_key: 'key123' } })
    mockUseMutation.mockReturnValue({ mutate: mockMutate, isPending: true })
    render(<Page />)
    expect(screen.getByRole('button', { name: /submitting/i })).toBeInTheDocument()
  })

  test('shows success screen after mutation onSuccess is called', () => {
    // Simulate mutation calling onSuccess immediately
    mockUseQuery.mockReturnValue({ data: { turnstile_site_key: 'key123' } })
    mockUseMutation.mockImplementation(({ onSuccess }: any) => ({
      mutate: () => act(() => onSuccess()),
      isPending: false,
    }))
    render(<Page />)
    fireEvent.click(screen.getByTestId('turnstile'))
    fireEvent.submit(screen.getByRole('button', { name: /submit request/i }).closest('form')!)
    expect(screen.getByText(/request received/i)).toBeInTheDocument()
  })
})
