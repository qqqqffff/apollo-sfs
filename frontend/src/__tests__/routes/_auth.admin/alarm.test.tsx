import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

jest.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: any) => ({ options: opts }),
}))

const mockQuery = jest.fn()
const mockMutation = jest.fn()
const mockQueryClient = jest.fn()

jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQuery:       (...args: any[]) => mockQuery(...args),
  useMutation:    (...args: any[]) => mockMutation(...args),
  useQueryClient: () => mockQueryClient(),
}))

const mockNotify = jest.fn()
jest.mock('../../../context/NotificationContext', () => ({
  useNotification: () => ({ notify: mockNotify }),
}))

jest.mock('../../../api/admin', () => ({
  alarmSettingsQueryOptions: { queryKey: ['admin', 'alarm', 'settings'], queryFn: jest.fn() },
  toggleAlarmSubscription: jest.fn(),
}))

jest.mock('../../../api/me', () => ({
  meQueryOptions: { queryKey: ['me'], queryFn: jest.fn() },
}))

jest.mock('../../../api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor(msg: string, status = 400) { super(msg); this.status = status }
  },
}))

import { Route } from '../../../routes/_auth.admin/alarm'
const Page = Route.options.component as React.ComponentType

const DEFAULT_SETTINGS = {
  cpu_usage_emails: [] as string[],
  cpu_usage_last_fired_at: null,
  cpu_temp_emails: [] as string[],
  cpu_temp_last_fired_at: null,
  drive_temp_emails: [] as string[],
  drive_temp_last_fired_at: null,
  drive_load_emails: [] as string[],
  drive_load_last_fired_at: null,
  network_traffic_emails: [] as string[],
  network_traffic_last_fired_at: null,
  api_error_rate_emails: [] as string[],
  api_error_rate_last_fired_at: null,
  updated_at: '2026-01-01T00:00:00Z',
}

const ME = { email: 'admin@example.com', username: 'admin' }

function setup(
  settings = DEFAULT_SETTINGS,
  me: { email: string } | null = ME,
  overrides: { isLoading?: boolean; error?: Error | null } = {},
) {
  const { isLoading = false, error = null } = overrides
  mockQuery.mockImplementation((opts: any) => {
    if (opts?.queryKey?.[0] === 'me') return { data: me }
    return { data: settings, isLoading, error }
  })
  mockMutation.mockReturnValue({ mutate: jest.fn(), isPending: false, variables: undefined })
  mockQueryClient.mockReturnValue({ setQueryData: jest.fn() })
  return render(<Page />)
}

describe('Admin Alarm Settings page', () => {
  beforeEach(() => {
    mockNotify.mockReset()
    mockQuery.mockReset()
    mockMutation.mockReset()
    mockQueryClient.mockReset()
  })

  test('renders the page heading', () => {
    setup()
    expect(screen.getByRole('heading', { name: /alarm settings/i })).toBeInTheDocument()
  })

  test('shows loading state', () => {
    setup(DEFAULT_SETTINGS, ME, { isLoading: true })
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  test('shows error state', () => {
    setup(DEFAULT_SETTINGS, ME, { error: new Error('fail') })
    expect(screen.getByText(/failed to load alarm settings/i)).toBeInTheDocument()
  })

  test('renders all six alarm toggle labels', () => {
    setup()
    expect(screen.getByText('CPU Usage')).toBeInTheDocument()
    expect(screen.getByText('CPU Temperature')).toBeInTheDocument()
    expect(screen.getByText('Drive Temperature')).toBeInTheDocument()
    expect(screen.getByText('Drive Load')).toBeInTheDocument()
    expect(screen.getByText('Network Traffic')).toBeInTheDocument()
    expect(screen.getByText('API Error Rate')).toBeInTheDocument()
  })

  test('renders six toggle switches', () => {
    setup()
    expect(screen.getAllByRole('switch')).toHaveLength(6)
  })

  test('all toggles start unchecked when email lists are empty', () => {
    setup()
    screen.getAllByRole('switch').forEach((sw) => {
      expect(sw).toHaveAttribute('aria-checked', 'false')
    })
  })

  test('toggle is checked when current user email is in subscriber list', () => {
    setup({ ...DEFAULT_SETTINGS, cpu_usage_emails: ['admin@example.com'] })
    const switches = screen.getAllByRole('switch')
    expect(switches[0]).toHaveAttribute('aria-checked', 'true')
    expect(switches[1]).toHaveAttribute('aria-checked', 'false')
  })

  test('two checked toggles when user is in two lists', () => {
    setup({
      ...DEFAULT_SETTINGS,
      cpu_usage_emails: ['admin@example.com'],
      drive_load_emails: ['admin@example.com'],
    })
    const checked = screen.getAllByRole('switch').filter(
      (sw) => sw.getAttribute('aria-checked') === 'true',
    )
    expect(checked).toHaveLength(2)
  })

  test('toggle is unchecked when user email is not in list', () => {
    setup({ ...DEFAULT_SETTINGS, cpu_usage_emails: ['other@example.com'] })
    const [first] = screen.getAllByRole('switch')
    expect(first).toHaveAttribute('aria-checked', 'false')
  })

  test('clicking a toggle calls mutation', () => {
    const mutate = jest.fn()
    mockMutation.mockReturnValue({ mutate, isPending: false, variables: undefined })
    mockQuery.mockImplementation((opts: any) => {
      if (opts?.queryKey?.[0] === 'me') return { data: ME }
      return { data: DEFAULT_SETTINGS, isLoading: false, error: null }
    })
    mockQueryClient.mockReturnValue({ setQueryData: jest.fn() })
    render(<Page />)

    fireEvent.click(screen.getAllByRole('switch')[0])
    expect(mutate).toHaveBeenCalledWith({ alarmType: 'cpu_usage', subscribed: true })
  })

  test('clicking a subscribed toggle unsubscribes', () => {
    const mutate = jest.fn()
    mockMutation.mockReturnValue({ mutate, isPending: false, variables: undefined })
    mockQuery.mockImplementation((opts: any) => {
      if (opts?.queryKey?.[0] === 'me') return { data: ME }
      return {
        data: { ...DEFAULT_SETTINGS, cpu_usage_emails: ['admin@example.com'] },
        isLoading: false,
        error: null,
      }
    })
    mockQueryClient.mockReturnValue({ setQueryData: jest.fn() })
    render(<Page />)

    fireEvent.click(screen.getAllByRole('switch')[0])
    expect(mutate).toHaveBeenCalledWith({ alarmType: 'cpu_usage', subscribed: false })
  })

  test('toggle is disabled while mutation is pending for that alarm', () => {
    mockMutation.mockReturnValue({
      mutate: jest.fn(),
      isPending: true,
      variables: { alarmType: 'cpu_usage', subscribed: true },
    })
    mockQuery.mockImplementation((opts: any) => {
      if (opts?.queryKey?.[0] === 'me') return { data: ME }
      return { data: DEFAULT_SETTINGS, isLoading: false, error: null }
    })
    mockQueryClient.mockReturnValue({ setQueryData: jest.fn() })
    render(<Page />)

    const [first] = screen.getAllByRole('switch')
    expect(first).toBeDisabled()
  })

  test('renders six info buttons', () => {
    setup()
    expect(screen.getAllByRole('button', { name: /show info for/i })).toHaveLength(6)
  })

  test('info panel is hidden by default', () => {
    setup()
    expect(screen.queryByText('Last sent:')).not.toBeInTheDocument()
  })

  test('clicking info button shows the panel', () => {
    setup()
    const [firstInfo] = screen.getAllByRole('button', { name: /show info for/i })
    fireEvent.click(firstInfo)
    expect(screen.getByText('Last sent:')).toBeInTheDocument()
  })

  test('info panel shows Never when last_fired_at is null', () => {
    setup()
    const [firstInfo] = screen.getAllByRole('button', { name: /show info for/i })
    fireEvent.click(firstInfo)
    expect(screen.getByText('Never')).toBeInTheDocument()
  })

  test('info panel shows No subscribers when email list is empty', () => {
    setup()
    const [firstInfo] = screen.getAllByRole('button', { name: /show info for/i })
    fireEvent.click(firstInfo)
    expect(screen.getByText(/no subscribers/i)).toBeInTheDocument()
  })

  test('info panel shows subscriber emails', () => {
    setup({ ...DEFAULT_SETTINGS, cpu_usage_emails: ['ops@example.com', 'sre@example.com'] })
    const [firstInfo] = screen.getAllByRole('button', { name: /show info for/i })
    fireEvent.click(firstInfo)
    expect(screen.getByText('ops@example.com')).toBeInTheDocument()
    expect(screen.getByText('sre@example.com')).toBeInTheDocument()
  })

  test('clicking info button again closes the panel', () => {
    setup()
    const [firstInfo] = screen.getAllByRole('button', { name: /show info for/i })
    fireEvent.click(firstInfo)
    expect(screen.getByText('Last sent:')).toBeInTheDocument()
    fireEvent.click(firstInfo)
    expect(screen.queryByText('Last sent:')).not.toBeInTheDocument()
  })

  test('each alarm description is visible', () => {
    setup()
    expect(screen.getAllByText(/≥ 90%.*30 minutes/i)).toHaveLength(2)
    expect(screen.getByText(/≥ 75°C/i)).toBeInTheDocument()
    expect(screen.getByText(/≥ 50°C/i)).toBeInTheDocument()
    expect(screen.getByText(/≥ 90%.*quota capacity/i)).toBeInTheDocument()
    expect(screen.getByText(/speed test/i)).toBeInTheDocument()
    expect(screen.getByText(/5%.*server error/i)).toBeInTheDocument()
  })

  test('no email form or save button present', () => {
    setup()
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/admin@example\.com/i)).not.toBeInTheDocument()
  })
})
