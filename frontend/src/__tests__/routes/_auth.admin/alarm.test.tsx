import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

jest.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: any) => ({ options: opts }),
}))

const mockQuery = jest.fn()
const mockInfiniteQuery = jest.fn()
const mockMutation = jest.fn()
const mockQueryClient = jest.fn()

jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQuery:         (...a: any[]) => mockQuery(...a),
  useInfiniteQuery: (...a: any[]) => mockInfiniteQuery(...a),
  useMutation:      (...a: any[]) => mockMutation(...a),
  useQueryClient:   () => mockQueryClient(),
}))

const mockNotify = jest.fn()
jest.mock('../../../context/NotificationContext', () => ({
  useNotification: () => ({ notify: mockNotify }),
}))

// api/admin is imported by both the page and the shared AlarmConfig component,
// so the mock must expose the threshold/unit/scope maps plus the API fns.
const ALL_TYPES = ['cpu_usage', 'cpu_temp', 'memory', 'network_traffic', 'drive_temp', 'drive_load', 'api_error_rate']
jest.mock('../../../api/admin', () => ({
  ALARM_DEFAULT_THRESHOLD: Object.fromEntries(ALL_TYPES.map(t => [t, 90])),
  ALARM_UNIT: Object.fromEntries(ALL_TYPES.map(t => [t, '%'])),
  ALARM_SCOPE: {
    cpu_usage: 'node', cpu_temp: 'node', memory: 'node', network_traffic: 'node',
    drive_temp: 'drive', drive_load: 'drive', api_error_rate: 'cluster',
  },
  adminUsersInfiniteQueryOptions: { queryKey: ['admin', 'users'] },
  infrastructureQueryOptions: { queryKey: ['admin', 'infrastructure'] },
  getAlarmSubscriptions: jest.fn(),
  upsertAlarmSubscription: jest.fn(),
  deleteAlarmSubscription: jest.fn(),
}))

import { Route } from '../../../routes/_auth.admin/alarm'
const Page = Route.options.component as React.ComponentType

const USERS = [
  { username: 'alice', email: 'alice@example.com' },
  { username: 'bob', email: 'bob@example.com' },
]

const SUBS = [
  {
    id: 's1', email: 'alice@example.com', alarm_type: 'cpu_usage',
    node_id: 'n1', drive_id: null, threshold: 90, last_fired_at: null,
    node_hostname: 'apollo-sfs-1', node_role: 'manager',
  },
]

const INFRA = {
  nodes: [{ node_id: 'n1', hostname: 'apollo-sfs-1', role: 'manager' }],
  drives: [{ drive_id: 'd1', drive_label: 'disk1', server_name: 'srv' }],
}

function setup(subs = SUBS) {
  mockInfiniteQuery.mockReturnValue({
    data: { pages: [{ items: USERS }] },
    hasNextPage: false, isFetchingNextPage: false, fetchNextPage: jest.fn(),
  })
  mockQuery.mockImplementation((opts: any) => {
    const key = opts?.queryKey ?? []
    if (key[0] === 'admin' && key[1] === 'infrastructure') return { data: INFRA }
    if (key[1] === 'alarm') return { data: subs, isLoading: false }
    return { data: undefined }
  })
  mockMutation.mockReturnValue({ mutate: jest.fn(), isPending: false })
  mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn() })
  return render(<Page />)
}

describe('Admin Alarm Configuration page', () => {
  beforeEach(() => {
    mockNotify.mockReset()
    mockQuery.mockReset()
    mockInfiniteQuery.mockReset()
    mockMutation.mockReset()
    mockQueryClient.mockReset()
  })

  test('renders the page heading', () => {
    setup()
    expect(screen.getByRole('heading', { name: /alarm configuration/i })).toBeInTheDocument()
  })

  test('prompts to select a user before one is chosen', () => {
    setup()
    expect(screen.getByText(/select a user to review their alarms/i)).toBeInTheDocument()
  })

  test('lists users from the paginated query', () => {
    setup()
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
  })

  test('filters users by the search box', () => {
    setup()
    fireEvent.change(screen.getByPlaceholderText(/search users/i), { target: { value: 'bob' } })
    expect(screen.queryByText('alice')).not.toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
  })

  test('selecting a user shows their subscriptions and the add form', () => {
    setup()
    fireEvent.click(screen.getByText('alice'))
    expect(screen.getByText(/subscriptions for alice/i)).toBeInTheDocument()
    expect(screen.getByText(/add alarm for alice/i)).toBeInTheDocument()
    expect(screen.getByText('High CPU usage')).toBeInTheDocument()
  })

  test('shows an empty state when a user has no alarms', () => {
    setup([])
    fireEvent.click(screen.getByText('alice'))
    expect(screen.getByText(/no alarms configured for this user/i)).toBeInTheDocument()
  })

  test('toggling a subscription off calls a mutation', () => {
    const mutate = jest.fn()
    mockMutation.mockReturnValue({ mutate, isPending: false })
    setup()
    fireEvent.click(screen.getByText('alice'))
    fireEvent.click(screen.getByRole('switch', { name: /toggle high cpu usage alarm/i }))
    expect(mutate).toHaveBeenCalled()
  })
})
