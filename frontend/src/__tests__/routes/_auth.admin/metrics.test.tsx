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
  infrastructureQueryOptions: { queryKey: ['admin', 'infrastructure'],  queryFn: jest.fn() },
  driveStatsQueryOptions:     { queryKey: ['admin', 'drive-stats'],     queryFn: jest.fn() },
  speedTestQueryOptions:      { queryKey: ['admin', 'speed-test'],      queryFn: jest.fn() },
  getMetricsHistoryByHours: jest.fn(),
  getNodeMetricsHistory: jest.fn(),
  getDriveTempsHistory: jest.fn(),
  // Never resolves — prevents useServerPing from calling setResult outside act().
  pingServer:       jest.fn().mockReturnValue(new Promise(() => {})),
  runTests:         jest.fn(),
  shutdownServer:   jest.fn(),
  triggerSpeedTest: jest.fn(),
  syncInfrastructure: jest.fn(),
}))

jest.mock('../../../components/BarGraph',  () => ({ BarGraph:  () => <div data-testid="bar-graph" /> }))
jest.mock('../../../components/LineGraph', () => ({ LineGraph: () => <div data-testid="line-graph" /> }))

const GB = 1024 ** 3

// Cluster snapshot — drives the users/storage + uplink (ping, loss) cards.
const SAMPLE_CLUSTER = {
  id: 'snap-1',
  sampled_at: new Date().toISOString(),
  cpu_percent: 0,
  memory_used_bytes: 0,
  memory_total_bytes: 0,
  network_bytes_sent: 1000,
  network_bytes_recv: 2000,
  storage_total_used_bytes: 500 * 1024 ** 2,
  storage_total_quota_bytes: 10 * GB,
  disk_total_bytes: 100 * GB,
  disk_free_bytes: 60 * GB,
  active_user_count: 3,
  total_user_count: 10,
  cpu_temp_celsius: null,
  drive_temp_celsius: null,
  server_isp_ping_ms: 14.3 as number | null,
  server_isp_packet_loss_percent: 0.0 as number | null,
}

// One node with two drives — drives the per-node hardware cards + carousel.
const SAMPLE_NODE = {
  node_id: 'n1',
  hostname: 'node-1',
  role: 'manager',
  is_active: true,
  online: true,
  cpu_percent: 12,
  cpu_temp_celsius: 42.5 as number | null,
  memory_used_bytes: 2 * GB,
  memory_total_bytes: 8 * GB,
  network_bytes_sent: 1000,
  network_bytes_recv: 2000,
  sampled_at: new Date().toISOString(),
  drives: [
    { drive_id: 'd1', label: 'nvme-01', drive_type: 'nvme', temp_celsius: 38.5, total_bytes: 500 * GB, used_bytes: 100 * GB, free_bytes: 400 * GB },
    { drive_id: 'd2', label: 'hdd-01',  drive_type: 'hdd',  temp_celsius: 52.0, total_bytes: 8000 * GB, used_bytes: 1000 * GB, free_bytes: 7000 * GB },
  ],
}

jest.mock('../../../hooks/useMetricsStream', () => ({
  useMetricsStream: () => ({ frames: [{ cluster: SAMPLE_CLUSTER, nodes: [SAMPLE_NODE] }], connected: true }),
}))

import { Route } from '../../../routes/_auth.admin/metrics'
const Page = Route.options.component as React.ComponentType

function setup() {
  mockQuery.mockImplementation((opts: any) => {
    const key: string[] = opts?.queryKey ?? []
    if (key.includes('infrastructure')) return { data: { nodes: [], drives: [] } }
    return { data: null }
  })
  mockMutation.mockReturnValue({ mutate: jest.fn(), isPending: false })
  mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn(), setQueryData: jest.fn() })
  return render(<Page />)
}

function resetMocks() {
  mockQuery.mockReset()
  mockMutation.mockReset()
  mockQueryClient.mockReset()
  mockNotify.mockReset()
}

// ── Node hardware ────────────────────────────────────────────────────────────────

describe('Admin Metrics — Node hardware', () => {
  beforeEach(resetMocks)

  test('renders the CPU card with utilization and temperature', () => {
    setup()
    expect(screen.getByText('CPU')).toBeInTheDocument()
    expect(screen.getByText('12%')).toBeInTheDocument()
    expect(screen.getByText('42.5°C')).toBeInTheDocument()
  })

  test('renders the Memory card for the selected node', () => {
    setup()
    expect(screen.getByText('Memory')).toBeInTheDocument()
    expect(screen.getByText('2.00 GB')).toBeInTheDocument()
  })

  test('drive-temp carousel shows the first drive temperature with colour coding', () => {
    setup()
    expect(screen.getByText('nvme-01')).toBeInTheDocument()
    const temp = screen.getByText('38.5°C')
    expect(temp).toBeInTheDocument()
    expect(temp.className).toContain('text-emerald-600') // < 45°C → green
  })

  test('drive-temp carousel pages to the next drive', () => {
    setup()
    fireEvent.click(screen.getByTitle('Next drive'))
    const temp = screen.getByText('52.0°C')
    expect(temp).toBeInTheDocument()
    expect(temp.className).toContain('text-amber-500') // 45–59.9°C → amber
  })

  test('renders the drive capacity card', () => {
    setup()
    expect(screen.getByText('Drive capacity')).toBeInTheDocument()
  })
})

// ── Ping card ──────────────────────────────────────────────────────────────────

describe('Admin Metrics — Ping card', () => {
  beforeEach(resetMocks)

  test('renders the "Ping" label', () => {
    setup()
    expect(screen.getByText('Ping')).toBeInTheDocument()
  })

  test('renders server ISP ping from the cluster snapshot', () => {
    setup()
    expect(screen.getByText('14.3 ms')).toBeInTheDocument()
  })

  test('renders "Server → ISP" and "Client → Server" labels', () => {
    setup()
    expect(screen.getAllByText('Server → ISP').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Client → Server').length).toBeGreaterThanOrEqual(1)
  })

  test('applies emerald colour for ping below 60 ms', () => {
    setup()
    expect(screen.getByText('14.3 ms').className).toContain('text-emerald-600')
  })

  test('amber ping (60–149 ms) applies amber colour', () => {
    jest.replaceProperty(SAMPLE_CLUSTER, 'server_isp_ping_ms', 80)
    setup()
    expect(screen.getByText('80.0 ms').className).toContain('text-amber-500')
    jest.replaceProperty(SAMPLE_CLUSTER, 'server_isp_ping_ms', 14.3)
  })

  test('red ping (≥150 ms) applies red colour', () => {
    jest.replaceProperty(SAMPLE_CLUSTER, 'server_isp_ping_ms', 200)
    setup()
    expect(screen.getByText('200.0 ms').className).toContain('text-red-600')
    jest.replaceProperty(SAMPLE_CLUSTER, 'server_isp_ping_ms', 14.3)
  })
})

// ── Packet loss card ───────────────────────────────────────────────────────────

describe('Admin Metrics — Packet loss card', () => {
  beforeEach(resetMocks)

  test('renders the "Packet loss" label', () => {
    setup()
    expect(screen.getByText('Packet loss')).toBeInTheDocument()
  })

  test('renders server ISP packet loss from the snapshot', () => {
    setup()
    const elements = screen.getAllByText('0.0%')
    expect(elements.length).toBeGreaterThanOrEqual(1)
  })

  test('applies amber colour for 1–9.9% packet loss', () => {
    jest.replaceProperty(SAMPLE_CLUSTER, 'server_isp_packet_loss_percent', 5)
    setup()
    expect(screen.getByText('5.0%').className).toContain('text-amber-500')
    jest.replaceProperty(SAMPLE_CLUSTER, 'server_isp_packet_loss_percent', 0.0)
  })

  test('applies red colour for ≥10% packet loss', () => {
    jest.replaceProperty(SAMPLE_CLUSTER, 'server_isp_packet_loss_percent', 20)
    setup()
    expect(screen.getByText('20.0%').className).toContain('text-red-600')
    jest.replaceProperty(SAMPLE_CLUSTER, 'server_isp_packet_loss_percent', 0.0)
  })

  test('renders "—" for server packet loss when null', () => {
    jest.replaceProperty(SAMPLE_CLUSTER, 'server_isp_packet_loss_percent', null)
    setup()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    jest.replaceProperty(SAMPLE_CLUSTER, 'server_isp_packet_loss_percent', 0.0)
  })
})

// ── Users & storage ─────────────────────────────────────────────────────────────

describe('Admin Metrics — Users & storage', () => {
  beforeEach(resetMocks)

  test('renders total and active user counts', () => {
    setup()
    expect(screen.getByText('Total users')).toBeInTheDocument()
    expect(screen.getByText('10')).toBeInTheDocument()
    expect(screen.getByText('Active (5 min)')).toBeInTheDocument()
  })

  test('renders the disk committed card', () => {
    setup()
    expect(screen.getByText('Disk committed')).toBeInTheDocument()
  })
})

// ── Infrastructure section ───────────────────────────────────────────────────────

describe('Admin Metrics — Infrastructure section', () => {
  beforeEach(resetMocks)

  test('renders the single "Sync infrastructure" button', () => {
    setup()
    expect(screen.getByText('Sync infrastructure')).toBeInTheDocument()
  })

  test('no longer renders the manual add/edit controls', () => {
    setup()
    expect(screen.queryByText('+ Add server')).not.toBeInTheDocument()
    expect(screen.queryByText('+ Add node')).not.toBeInTheDocument()
    expect(screen.queryByText('+ Add drive')).not.toBeInTheDocument()
  })

  test('clicking Sync infrastructure fires the sync mutation', () => {
    const mutate = jest.fn()
    mockQuery.mockImplementation((opts: any) => {
      const key: string[] = opts?.queryKey ?? []
      if (key.includes('infrastructure')) return { data: { nodes: [], drives: [] } }
      return { data: null }
    })
    mockMutation.mockReturnValue({ mutate, isPending: false })
    mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn(), setQueryData: jest.fn() })
    render(<Page />)
    screen.getByText('Sync infrastructure').click()
    expect(mutate).toHaveBeenCalled()
  })

  test('shows the empty state when no infrastructure is indexed', () => {
    setup()
    expect(screen.getByText(/No infrastructure indexed yet/)).toBeInTheDocument()
  })
})
