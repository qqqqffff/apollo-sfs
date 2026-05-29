import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom'

jest.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: any) => ({ options: opts }),
}))

const mockInfiniteQuery = jest.fn()
const mockQuery = jest.fn()
const mockMutation = jest.fn()
const mockQueryClient = jest.fn()

jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useInfiniteQuery: (...args: any[]) => mockInfiniteQuery(...args),
  useQuery:         (...args: any[]) => mockQuery(...args),
  useMutation:      (...args: any[]) => mockMutation(...args),
  useQueryClient:   () => mockQueryClient(),
}))

const mockNotify = jest.fn()
jest.mock('../../../context/NotificationContext', () => ({
  useNotification: () => ({ notify: mockNotify }),
}))

jest.mock('../../../api/inboundEmails', () => ({
  emailWorkersQueryOptions: { queryKey: ['admin', 'emails', 'workers'], queryFn: jest.fn() },
  emailsInfiniteQueryOptions: (worker?: string) => ({ queryKey: ['admin', 'emails', 'list', worker ?? 'all'] }),
  getEmail: jest.fn(),
  markEmailRead: jest.fn(),
  deleteEmail: jest.fn(),
}))

jest.mock('../../../api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number
    constructor(msg: string, status = 400) { super(msg); this.status = status }
  },
}))

import { Route } from '../../../routes/_auth.admin/emails'
const Page = Route.options.component as React.ComponentType

const WORKERS = [
  { worker_name: 'support', total_count: 3, unread_count: 2 },
  { worker_name: 'billing', total_count: 1, unread_count: 0 },
]

const EMAILS = [
  {
    id: 'e1',
    worker_name: 'support',
    from_addr: 'alice@example.com',
    to_addr: 'support@example.com',
    subject: 'Need help',
    has_attachments: false,
    read: false,
    received_at: '2026-05-01T10:00:00Z',
  },
]

const DETAIL = {
  ...EMAILS[0],
  read: true, // read so the auto-mark-read effect does not fire
  message: {
    message_id: '<x@y>',
    from: 'alice@example.com',
    to: 'support@example.com',
    subject: 'Need help',
    date: '2026-05-01T10:00:00Z',
    text: 'please assist',
    html: '', // empty html => plain-text path, no dompurify import
    headers: '',
    attachments: [],
  },
}

const mockMutate = jest.fn()

function setup(opts: { emails?: any[]; emptyList?: boolean } = {}) {
  const emails = opts.emptyList ? [] : (opts.emails ?? EMAILS)

  mockQuery.mockImplementation((q: any) => {
    const key = q?.queryKey ?? []
    if (key[2] === 'workers') return { data: { workers: WORKERS }, isLoading: false }
    if (key[2] === 'detail') {
      // Only return detail once an email is selected (4th key element set).
      return { data: key[3] ? DETAIL : undefined, isLoading: false }
    }
    return { data: undefined }
  })

  mockInfiniteQuery.mockReturnValue({
    data: { pages: [{ items: emails, next_token: '' }] },
    isLoading: false,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(),
  })

  mockMutation.mockReturnValue({ mutate: mockMutate, isPending: false })
  mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn() })

  return render(<Page />)
}

describe('Admin Service emails page', () => {
  beforeEach(() => {
    mockNotify.mockReset()
    mockQuery.mockReset()
    mockInfiniteQuery.mockReset()
    mockMutation.mockReset()
    mockQueryClient.mockReset()
    mockMutate.mockReset()
  })

  test('renders the Service emails heading', () => {
    setup()
    expect(screen.getByRole('heading', { name: /service emails/i })).toBeInTheDocument()
  })

  test('renders worker sidebar with All and mailbox names', () => {
    setup()
    const sidebar = within(screen.getByRole('complementary'))
    expect(sidebar.getByRole('button', { name: /All/ })).toBeInTheDocument()
    expect(sidebar.getByRole('button', { name: /support/ })).toBeInTheDocument()
    expect(sidebar.getByRole('button', { name: /billing/ })).toBeInTheDocument()
  })

  test('shows the unread badge total on All', () => {
    setup()
    // unreadAll = 2 + 0 = 2
    const allBtn = within(screen.getByRole('complementary')).getByRole('button', { name: /All/ })
    expect(allBtn).toHaveTextContent('2')
  })

  test('renders the email list with sender and subject', () => {
    setup()
    expect(screen.getByText('alice@example.com')).toBeInTheDocument()
    expect(screen.getByText('Need help')).toBeInTheDocument()
  })

  test('renders empty state when there are no emails', () => {
    setup({ emptyList: true })
    expect(screen.getByText(/no emails/i)).toBeInTheDocument()
  })

  test('shows placeholder until an email is selected', () => {
    setup()
    expect(screen.getByText(/select an email to read it/i)).toBeInTheDocument()
  })

  test('selecting an email opens the detail pane', () => {
    setup()
    fireEvent.click(screen.getByText('Need help'))
    // Detail pane shows the From line.
    expect(screen.getByText(/From:/)).toBeInTheDocument()
    expect(screen.getByText('please assist')).toBeInTheDocument()
  })

  test('delete flow requires confirmation then fires the mutation', () => {
    setup()
    fireEvent.click(screen.getByText('Need help'))

    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }))
    const confirm = screen.getByRole('button', { name: /confirm delete/i })
    expect(confirm).toBeInTheDocument()

    fireEvent.click(confirm)
    expect(mockMutate).toHaveBeenCalledWith('e1')
  })
})
