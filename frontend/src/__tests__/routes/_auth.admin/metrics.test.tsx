import React from 'react'
import { render, screen } from '@testing-library/react'
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
  infrastructureQueryOptions: { queryKey: ['admin', 'infrastructure'],  queryFn: jest.fn() },
  driveTempsQueryOptions:     { queryKey: ['admin', 'drive-temps'],     queryFn: jest.fn() },
  speedTestQueryOptions:      { queryKey: ['admin', 'speed-test'],      queryFn: jest.fn() },
  getMetricsHistoryByHours: jest.fn(),
  runTests:         jest.fn(),
  shutdownServer:   jest.fn(),
  triggerSpeedTest: jest.fn(),
  createServer:     jest.fn(),
  updateServer:     jest.fn(),
  addDrive:         jest.fn(),
  updateDrive:      jest.fn(),
}))

jest.mock('../../../components/BarGraph',  () => ({ BarGraph:  () => <div data-testid="bar-graph" /> }))
jest.mock('../../../components/LineGraph', () => ({ LineGraph: () => <div data-testid="line-graph" /> }))

// Provide a minimal snapshot so `latest` is defined and the stats grid renders.
const SAMPLE_SNAPSHOT = {
  id: 'snap-1',
  sampled_at: new Date().toISOString(),
  cpu_percent: 12,
  memory_used_bytes: 2 * 1024 ** 3,
  memory_total_bytes: 8 * 1024 ** 3,
  network_bytes_sent: 1000,
  network_bytes_recv: 2000,
  storage_total_used_bytes: 500 * 1024 ** 2,
  storage_total_quota_bytes: 10 * 1024 ** 3,
  disk_total_bytes: 100 * 1024 ** 3,
  disk_free_bytes: 60 * 1024 ** 3,
  active_user_count: 3,
  total_user_count: 10,
  cpu_temp_celsius: null,
  drive_temp_celsius: null,
}

jest.mock('../../../hooks/useMetricsStream', () => ({
  useMetricsStream: () => ({ snapshots: [SAMPLE_SNAPSHOT], connected: true }),
}))

import { Route } from '../../../routes/_auth.admin/metrics'
const Page = Route.options.component as React.ComponentType

const DRIVE_TEMPS = [
  { name: 'nvme-pci-0100 Composite', temp_celsius: 38.5 },
  { name: 'nvme-pci-0200 Composite', temp_celsius: 52.0 },
  { name: 'nvme-pci-0300 Composite', temp_celsius: 65.0 },
]

function setup(driveTemps = DRIVE_TEMPS) {
  mockQuery.mockImplementation((opts: any) => {
    const key: string[] = opts?.queryKey ?? []
    if (key.includes('drive-temps')) return { data: driveTemps }
    if (key.includes('infrastructure')) return { data: { drives: [] } }
    return { data: null }
  })
  mockMutation.mockReturnValue({ mutate: jest.fn(), isPending: false })
  mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn(), setQueryData: jest.fn() })
  return render(<Page />)
}

describe('Admin Metrics — NvMe temps card', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockMutation.mockReset()
    mockQueryClient.mockReset()
    mockNotify.mockReset()
  })

  // ── Visibility ──────────────────────────────────────────────────────────────

  test('renders the "NVMe temps" label when drives are present', () => {
    setup()
    expect(screen.getByText('NVMe temps')).toBeInTheDocument()
  })

  test('does not render the card when drive temps array is empty', () => {
    setup([])
    expect(screen.queryByText('NVMe temps')).not.toBeInTheDocument()
  })

  test('does not render the card when driveTemps is undefined', () => {
    mockQuery.mockReturnValue({ data: undefined })
    mockMutation.mockReturnValue({ mutate: jest.fn(), isPending: false })
    mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn(), setQueryData: jest.fn() })
    render(<Page />)
    expect(screen.queryByText('NVMe temps')).not.toBeInTheDocument()
  })

  // ── Content ─────────────────────────────────────────────────────────────────

  test('renders each drive name via title attribute', () => {
    setup()
    expect(screen.getByTitle('nvme-pci-0100 Composite')).toBeInTheDocument()
    expect(screen.getByTitle('nvme-pci-0200 Composite')).toBeInTheDocument()
    expect(screen.getByTitle('nvme-pci-0300 Composite')).toBeInTheDocument()
  })

  test('renders all drive temperatures formatted to one decimal place', () => {
    setup()
    expect(screen.getByText('38.5°C')).toBeInTheDocument()
    expect(screen.getByText('52.0°C')).toBeInTheDocument()
    expect(screen.getByText('65.0°C')).toBeInTheDocument()
  })

  test('renders a single drive correctly', () => {
    setup([{ name: 'nvme-only', temp_celsius: 41.2 }])
    expect(screen.getByTitle('nvme-only')).toBeInTheDocument()
    expect(screen.getByText('41.2°C')).toBeInTheDocument()
  })

  // ── Temperature colour coding ───────────────────────────────────────────────

  test('applies green (emerald-600) for temp below 45°C', () => {
    setup([{ name: 'nvme-cool', temp_celsius: 38.5 }])
    expect(screen.getByText('38.5°C').className).toContain('text-emerald-600')
  })

  test('applies amber (amber-500) for temp between 45°C and 59.9°C', () => {
    setup([{ name: 'nvme-warm', temp_celsius: 52.0 }])
    expect(screen.getByText('52.0°C').className).toContain('text-amber-500')
  })

  test('applies red (red-600) for temp at or above 60°C', () => {
    setup([{ name: 'nvme-hot', temp_celsius: 65.0 }])
    expect(screen.getByText('65.0°C').className).toContain('text-red-600')
  })

  test('applies amber at exactly the 45°C lower boundary', () => {
    setup([{ name: 'nvme-boundary-low', temp_celsius: 45.0 }])
    expect(screen.getByText('45.0°C').className).toContain('text-amber-500')
  })

  test('applies red at exactly the 60°C upper boundary', () => {
    setup([{ name: 'nvme-boundary-high', temp_celsius: 60.0 }])
    expect(screen.getByText('60.0°C').className).toContain('text-red-600')
  })

  test('applies green just below the 45°C boundary', () => {
    setup([{ name: 'nvme-just-cool', temp_celsius: 44.9 }])
    expect(screen.getByText('44.9°C').className).toContain('text-emerald-600')
  })

  // ── Scroll container ────────────────────────────────────────────────────────

  test('scroll container is present', () => {
    setup()
    // The scrollable list has overflow-y-auto
    const scrollable = document.querySelector('.overflow-y-auto')
    expect(scrollable).toBeInTheDocument()
  })

  test('all drive rows are rendered inside the scroll container', () => {
    setup(Array.from({ length: 5 }, (_, i) => ({ name: `nvme-${i}`, temp_celsius: 40 + i })))
    const scrollable = document.querySelector('.overflow-y-auto')!
    const rows = scrollable.querySelectorAll('[title^="nvme-"]')
    expect(rows).toHaveLength(5)
  })
})
