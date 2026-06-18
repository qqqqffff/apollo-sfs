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
  validateApplePayMerchantForDeposit: jest.fn(),
  createApplePayInterestDeposit: jest.fn(),
  createGooglePayInterestDeposit: jest.fn(),
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

  test('required fields have a star indicator', () => {
    renderPage()
    // Label text content includes the * character for required fields
    const nameLabel = screen.getByText((_, el) => el?.tagName === 'LABEL' && /full name/i.test(el.textContent ?? ''))
    const useCaseLabel = screen.getByText((_, el) => el?.tagName === 'LABEL' && /reason/i.test(el.textContent ?? ''))
    expect(nameLabel.textContent).toContain('*')
    expect(useCaseLabel.textContent).toContain('*')
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

  test('payment buttons are disabled when no plan is selected', () => {
    renderPage(null)
    // PayPal and Card buttons exist but are disabled without a plan + captcha
    const paypalBtn = screen.getByRole('button', { name: /paypal/i })
    const cardBtn = screen.getByRole('button', { name: /pay by card/i })
    expect(paypalBtn).toBeDisabled()
    expect(cardBtn).toBeDisabled()
  })

  test('shows captcha error when PayPal clicked without captcha token', async () => {
    // Turnstile is required (site key present) but not completed → inline error
    renderPage({ turnstile_site_key: 'key123' })
    fireEvent.click(screen.getByRole('button', { name: /64 gb/i }))
    // Button is now enabled (plan selected); captcha not yet done
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /paypal/i }))
    })
    expect(screen.getByText(/please complete the security check/i)).toBeInTheDocument()
  })

  test('Turnstile widget renders when config has a site key', () => {
    renderPage({ turnstile_site_key: 'key123' })
    expect(screen.getByTestId('turnstile')).toBeInTheDocument()
  })

  test('selecting a plan and completing captcha enables the payment buttons', () => {
    renderPage({ turnstile_site_key: 'key123' })
    // 256 GB NVMe = $80 → deposit $40.00
    fireEvent.click(screen.getByRole('button', { name: /256 gb/i }))
    fireEvent.click(screen.getByTestId('turnstile'))
    expect(screen.getByRole('button', { name: /paypal/i })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /pay by card/i })).not.toBeDisabled()
    // Deposit amount visible (50% of $80 = $40)
    expect(screen.getByText(/\$40\.00 refundable deposit/i)).toBeInTheDocument()
  })

  test('clicking PayPal button calls createInterestDepositOrder with paypal method', async () => {
    mockCreateDepositOrder.mockResolvedValue({ order_id: 'ord-1', approve_url: 'https://paypal.example' })
    renderPage({ turnstile_site_key: 'key123' })
    fireEvent.click(screen.getByRole('button', { name: /256 gb/i }))
    fireEvent.click(screen.getByTestId('turnstile'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /paypal/i }))
    })
    expect(mockCreateDepositOrder).toHaveBeenCalledWith('256gb', 'nvme', 'paypal')
  })

  test('clicking Pay by Card calls createInterestDepositOrder with card method', async () => {
    mockCreateDepositOrder.mockResolvedValue({ order_id: 'ord-2', approve_url: 'https://card.example' })
    renderPage({ turnstile_site_key: 'key123' })
    fireEvent.click(screen.getByRole('button', { name: /128 gb/i }))
    fireEvent.click(screen.getByTestId('turnstile'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /pay by card/i }))
    })
    expect(mockCreateDepositOrder).toHaveBeenCalledWith('128gb', 'nvme', 'card')
  })

  test('shows Processing… on payment buttons while deposit order is pending', () => {
    mockCreateDepositOrder.mockReturnValue(new Promise(() => {}))
    renderPage({ turnstile_site_key: 'key123' })
    fireEvent.click(screen.getByRole('button', { name: /64 gb/i }))
    fireEvent.click(screen.getByTestId('turnstile'))
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /paypal/i }))
    })
    expect(screen.getAllByText(/processing…/i).length).toBeGreaterThan(0)
  })

  test('shows awaiting screen and opens URL after deposit order is created', async () => {
    mockCreateDepositOrder.mockResolvedValue({ order_id: 'ord-1', approve_url: 'https://paypal.example' })
    renderPage({ turnstile_site_key: 'key123' })
    fireEvent.click(screen.getByRole('button', { name: /128 gb/i }))
    fireEvent.click(screen.getByTestId('turnstile'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /paypal/i }))
    })
    expect(window.open).toHaveBeenCalledWith('https://paypal.example', '_blank', 'noopener,noreferrer')
    expect(screen.getByRole('button', { name: /i've completed payment/i })).toBeInTheDocument()
  })
})
