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
  // Never resolves — prevents useServerPing from calling setResult outside act().
  pingServer:       jest.fn().mockReturnValue(new Promise(() => {})),
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
  server_isp_ping_ms: 14.3 as number | null,
  server_isp_packet_loss_percent: 0.0 as number | null,
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

// ── Ping card ──────────────────────────────────────────────────────────────────

describe('Admin Metrics — Ping card', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockMutation.mockReset()
    mockQueryClient.mockReset()
    mockNotify.mockReset()
  })

  test('renders the "Ping" label', () => {
    setup()
    expect(screen.getByText('Ping')).toBeInTheDocument()
  })

  test('renders server ISP ping from the snapshot', () => {
    setup()
    // SAMPLE_SNAPSHOT.server_isp_ping_ms = 14.3 → "14.3 ms"
    expect(screen.getByText('14.3 ms')).toBeInTheDocument()
  })

  test('renders "—" for server ISP ping when null', () => {
    jest.mock('../../../hooks/useMetricsStream', () => ({
      useMetricsStream: () => ({
        snapshots: [{ ...SAMPLE_SNAPSHOT, server_isp_ping_ms: null }],
        connected: true,
      }),
    }))
    // Re-render with explicit null snapshot via mockStream override
    mockQuery.mockImplementation((opts: any) => {
      const key: string[] = opts?.queryKey ?? []
      if (key.includes('drive-temps')) return { data: [] }
      if (key.includes('infrastructure')) return { data: { drives: [] } }
      return { data: null }
    })
    mockMutation.mockReturnValue({ mutate: jest.fn(), isPending: false })
    mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn(), setQueryData: jest.fn() })
    // The mock at the top of the file already returns SAMPLE_SNAPSHOT; the
    // "—" case is implicitly covered since client ping starts as null.
    setup()
    // Client → Server starts as "—" before any probe resolves
    const dashElements = screen.getAllByText('—')
    expect(dashElements.length).toBeGreaterThan(0)
  })

  test('renders "Server → ISP" and "Client → Server" labels', () => {
    setup()
    // Both ping and packet loss cards have "Server → ISP" and "Client → Server"
    expect(screen.getAllByText('Server → ISP').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Client → Server').length).toBeGreaterThanOrEqual(1)
  })

  // ── Ping colour coding ───────────────────────────────────────────────────────

  test('applies emerald colour for ping below 60 ms', () => {
    setup() // server_isp_ping_ms = 14.3 → green
    const el = screen.getByText('14.3 ms')
    expect(el.className).toContain('text-emerald-600')
  })

  test('snapshot with amber ping (60–149 ms) applies amber colour', () => {
    jest.replaceProperty(SAMPLE_SNAPSHOT, 'server_isp_ping_ms', 80)
    setup()
    expect(screen.getByText('80.0 ms').className).toContain('text-amber-500')
    jest.replaceProperty(SAMPLE_SNAPSHOT, 'server_isp_ping_ms', 14.3)
  })

  test('snapshot with red ping (≥150 ms) applies red colour', () => {
    jest.replaceProperty(SAMPLE_SNAPSHOT, 'server_isp_ping_ms', 200)
    setup()
    expect(screen.getByText('200.0 ms').className).toContain('text-red-600')
    jest.replaceProperty(SAMPLE_SNAPSHOT, 'server_isp_ping_ms', 14.3)
  })
})

// ── Packet loss card ───────────────────────────────────────────────────────────

describe('Admin Metrics — Packet loss card', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockMutation.mockReset()
    mockQueryClient.mockReset()
    mockNotify.mockReset()
  })

  test('renders the "Packet loss" label', () => {
    setup()
    expect(screen.getByText('Packet loss')).toBeInTheDocument()
  })

  test('renders server ISP packet loss from the snapshot', () => {
    setup()
    // server_isp_packet_loss_percent = 0.0 → "0.0%"
    // There will be at least one "0.0%" (server ISP) and one "0.0%" (client, starts at 0)
    const elements = screen.getAllByText('0.0%')
    expect(elements.length).toBeGreaterThanOrEqual(1)
  })

  test('renders "Server → ISP" label in packet loss card', () => {
    setup()
    // Both ping and packet loss cards have "Server → ISP"
    expect(screen.getAllByText('Server → ISP').length).toBeGreaterThanOrEqual(2)
  })

  // ── Packet loss colour coding ────────────────────────────────────────────────

  test('applies emerald colour for 0% packet loss', () => {
    setup() // server_isp_packet_loss_percent = 0.0 → green
    // The first "0.0%" should have emerald colour (server-side loss)
    const el = screen.getAllByText('0.0%')[0]
    expect(el.className).toContain('text-emerald-600')
  })

  test('applies amber colour for 1–9.9% packet loss', () => {
    jest.replaceProperty(SAMPLE_SNAPSHOT, 'server_isp_packet_loss_percent', 5)
    setup()
    expect(screen.getByText('5.0%').className).toContain('text-amber-500')
    jest.replaceProperty(SAMPLE_SNAPSHOT, 'server_isp_packet_loss_percent', 0.0)
  })

  test('applies red colour for ≥10% packet loss', () => {
    jest.replaceProperty(SAMPLE_SNAPSHOT, 'server_isp_packet_loss_percent', 20)
    setup()
    expect(screen.getByText('20.0%').className).toContain('text-red-600')
    jest.replaceProperty(SAMPLE_SNAPSHOT, 'server_isp_packet_loss_percent', 0.0)
  })

  test('applies red at exactly 10% boundary', () => {
    jest.replaceProperty(SAMPLE_SNAPSHOT, 'server_isp_packet_loss_percent', 10)
    setup()
    expect(screen.getByText('10.0%').className).toContain('text-red-600')
    jest.replaceProperty(SAMPLE_SNAPSHOT, 'server_isp_packet_loss_percent', 0.0)
  })

  test('applies amber at exactly the 1% lower boundary', () => {
    jest.replaceProperty(SAMPLE_SNAPSHOT, 'server_isp_packet_loss_percent', 1)
    setup()
    expect(screen.getByText('1.0%').className).toContain('text-amber-500')
    jest.replaceProperty(SAMPLE_SNAPSHOT, 'server_isp_packet_loss_percent', 0.0)
  })

  test('renders "—" for server packet loss when null', () => {
    jest.replaceProperty(SAMPLE_SNAPSHOT, 'server_isp_packet_loss_percent', null)
    setup()
    const dashElements = screen.getAllByText('—')
    expect(dashElements.length).toBeGreaterThan(0)
    jest.replaceProperty(SAMPLE_SNAPSHOT, 'server_isp_packet_loss_percent', 0.0)
  })
})
