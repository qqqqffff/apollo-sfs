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
  createInterestDepositOrder: jest.fn(),
  captureInterestDepositOrder: jest.fn(),
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
import { createInterestDepositOrder, captureInterestDepositOrder } from '../../api/interest'

const mockCreateDepositOrder = createInterestDepositOrder as jest.Mock
const mockCaptureDepositOrder = captureInterestDepositOrder as jest.Mock

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
    mockCreateDepositOrder.mockReset()
    mockCaptureDepositOrder.mockReset()
    window.open = jest.fn()
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

  test('renders the five plan capacity options', () => {
    renderPage()
    expect(screen.getByRole('button', { name: /64 gb/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /128 gb/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /256 gb/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /512 gb/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /1 tb/i })).toBeInTheDocument()
  })

  test('clicking a plan card shows the deposit notice with 50% deposit', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /128 gb/i }))
    // 128 GB NVMe = $50 → 50% deposit = $25.00
    expect(screen.getByText(/\$25\.00 refundable deposit/i)).toBeInTheDocument()
  })

  test('storage type toggle switches the displayed deposit amount', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /64 gb/i }))
    // Default Fast (NVMe): 64 GB = $30 → deposit $15.00
    expect(screen.getByText(/\$15\.00 refundable deposit/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /standard/i }))
    // Standard (HDD): 64 GB = $20 → deposit $10.00
    expect(screen.getByText(/\$10\.00 refundable deposit/i)).toBeInTheDocument()
  })

  test('submit button is disabled when no plan selected and no captcha', () => {
    // No config → no Turnstile widget → captchaToken stays null
    renderPage(null)
    expect(screen.getByRole('button', { name: /select a plan to continue/i })).toBeDisabled()
  })

  test('shows captcha error when form submitted without token', () => {
    renderPage(null)
    fireEvent.click(screen.getByRole('button', { name: /64 gb/i }))
    fireEvent.submit(screen.getByRole('button', { name: /via paypal/i }).closest('form')!)
    expect(screen.getByText(/please complete the security check/i)).toBeInTheDocument()
  })

  test('Turnstile widget renders when config has a site key', () => {
    renderPage({ turnstile_site_key: 'key123' })
    expect(screen.getByTestId('turnstile')).toBeInTheDocument()
  })

  test('selecting a plan and completing captcha enables the submit button', () => {
    renderPage({ turnstile_site_key: 'key123' })
    fireEvent.click(screen.getByRole('button', { name: /256 gb/i }))
    fireEvent.click(screen.getByTestId('turnstile'))
    // Button should be enabled and show deposit amount
    expect(screen.getByRole('button', { name: /\$50\.00 deposit via paypal/i })).not.toBeDisabled()
  })

  test('submitting calls createInterestDepositOrder with plan id and storage type', async () => {
    mockCreateDepositOrder.mockResolvedValue({ order_id: 'ord-1', approve_url: 'https://paypal.example' })
    renderPage({ turnstile_site_key: 'key123' })
    fireEvent.click(screen.getByRole('button', { name: /256 gb/i }))
    fireEvent.click(screen.getByTestId('turnstile'))
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /deposit via paypal/i }).closest('form')!)
    })
    expect(mockCreateDepositOrder).toHaveBeenCalledWith('256gb', 'nvme')
  })

  test('shows "Opening PayPal…" while deposit order is being created', () => {
    mockCreateDepositOrder.mockReturnValue(new Promise(() => {}))
    renderPage({ turnstile_site_key: 'key123' })
    fireEvent.click(screen.getByRole('button', { name: /64 gb/i }))
    fireEvent.click(screen.getByTestId('turnstile'))
    act(() => {
      fireEvent.submit(screen.getByRole('button', { name: /deposit via paypal/i }).closest('form')!)
    })
    expect(screen.getByRole('button', { name: /opening paypal/i })).toBeInTheDocument()
  })

  test('shows awaiting screen and opens PayPal after deposit order is created', async () => {
    mockCreateDepositOrder.mockResolvedValue({ order_id: 'ord-1', approve_url: 'https://paypal.example' })
    renderPage({ turnstile_site_key: 'key123' })
    fireEvent.click(screen.getByRole('button', { name: /128 gb/i }))
    fireEvent.click(screen.getByTestId('turnstile'))
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /deposit via paypal/i }).closest('form')!)
    })
    expect(window.open).toHaveBeenCalledWith('https://paypal.example', '_blank', 'noopener,noreferrer')
    expect(screen.getByRole('button', { name: /i've completed payment/i })).toBeInTheDocument()
  })
})
