import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EmailBackupView } from '../../components/EmailBackupView'
import { NotificationProvider } from '../../context/NotificationContext'
import type { Folder } from '../../types/api'
import type { EmailBackupMessage } from '../../types/emailBackup'

// EmailBackupView calls the *QueryOptions factories directly, and those close
// over the real list* functions inside the same module — mocking list*
// alone wouldn't reach them (the real queryFn keeps its own reference).
// Mocking the factories themselves is what the component actually imports.
const mockRecipients = jest.fn()
const mockMessages = jest.fn()
const getEmailBackupMessage = jest.fn()
const markEmailBackupMessageRead = jest.fn()
const deleteEmailBackupMessage = jest.fn()

jest.mock('../../api/emailBackup', () => ({
  ...jest.requireActual('../../api/emailBackup'),
  emailBackupSendersQueryOptions: (folderId: string) => ({
    queryKey: ['test', 'senders', folderId],
    queryFn: () => Promise.resolve({ senders: [] }),
  }),
  emailBackupRecipientsQueryOptions: (folderId: string) => ({
    queryKey: ['test', 'recipients', folderId],
    queryFn: () => mockRecipients(folderId),
  }),
  emailBackupMessagesInfiniteQueryOptions: (folderId: string, sender?: string, recipient?: string) => ({
    queryKey: ['test', 'messages', folderId, sender ?? 'all', recipient ?? 'all'],
    queryFn: () => mockMessages(folderId, sender, recipient),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: () => undefined,
  }),
  getEmailBackupMessage: (...a: unknown[]) => getEmailBackupMessage(...a),
  markEmailBackupMessageRead: (...a: unknown[]) => markEmailBackupMessageRead(...a),
  deleteEmailBackupMessage: (...a: unknown[]) => deleteEmailBackupMessage(...a),
}))

const folder: Folder = {
  id: 'f1',
  user_id: 'u1',
  parent_id: null,
  name: 'user@example.com',
  kind: 'email',
  size_bytes: 0,
  drive_id: null,
  ai_recognition_enabled: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

function makeMessage(i: number, over: Partial<EmailBackupMessage> = {}): EmailBackupMessage {
  return {
    id: `m${i}`,
    folder_id: 'f1',
    file_id: `file-${i}`,
    provider: 'gmail',
    provider_message_id: `pm-${i}`,
    from_addr: `sender${i}@x.com`,
    to_addr: 'me@y.com',
    subject: `Subject ${i}`,
    snippet: '',
    has_attachments: false,
    starred: false,
    read: true,
    received_at: '2026-01-0' + ((i % 9) + 1) + 'T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function renderView(props: Partial<React.ComponentProps<typeof EmailBackupView>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={client}>
      <NotificationProvider>
        <EmailBackupView folder={folder} readOnly={false} onBack={jest.fn()} {...props} />
      </NotificationProvider>
    </QueryClientProvider>,
  )
  return { ...utils, client }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRecipients.mockResolvedValue({
    recipients: [
      { to_addr: 'me@y.com', total_count: 2, unread_count: 1 },
      { to_addr: 'alias+shop@y.com', total_count: 1, unread_count: 0 },
    ],
  })
  mockMessages.mockImplementation((_folderId: string, _sender?: string, recipient?: string) => {
    if (recipient === 'me@y.com') {
      return Promise.resolve({ items: [makeMessage(1), makeMessage(2)], next_token: '' })
    }
    if (recipient === 'alias+shop@y.com') {
      return Promise.resolve({ items: [makeMessage(3)], next_token: '' })
    }
    return Promise.resolve({ items: [makeMessage(1), makeMessage(2), makeMessage(3)], next_token: '' })
  })
})

describe('EmailBackupView mobile recipient grouping', () => {
  it('defaults to the flat subjects list', async () => {
    renderView()
    expect(await screen.findAllByText('Subject 1')).not.toHaveLength(0)
    expect(screen.queryByText('me@y.com')).not.toBeInTheDocument()
  })

  it('shows grouped recipients with counts when toggled, and drills into one on tap', async () => {
    renderView()
    await screen.findAllByText('Subject 1')

    fireEvent.click(screen.getByRole('button', { name: /Recipients/i }))

    const recipientRow = await screen.findByText('me@y.com')
    expect(recipientRow).toBeInTheDocument()
    expect(screen.getByText('alias+shop@y.com')).toBeInTheDocument()
    // Unread badge for me@y.com and the total-count badge for the other
    // recipient both happen to read "1".
    expect(screen.getAllByText('1')).toHaveLength(2)

    fireEvent.click(recipientRow)

    await waitFor(() => {
      expect(mockMessages).toHaveBeenCalledWith('f1', undefined, 'me@y.com')
    })
    expect(await screen.findByText('All recipients')).toBeInTheDocument()
  })

  it('returns to the grouped list when "All recipients" is pressed', async () => {
    renderView()
    await screen.findAllByText('Subject 1')

    fireEvent.click(screen.getByRole('button', { name: /Recipients/i }))
    fireEvent.click(await screen.findByText('me@y.com'))
    await screen.findByText('All recipients')

    fireEvent.click(screen.getByText('All recipients'))

    expect(screen.queryByText('All recipients')).not.toBeInTheDocument()
    expect(await screen.findByText('alias+shop@y.com')).toBeInTheDocument()
  })

  it('filters the grouped recipient list via the search bar', async () => {
    renderView()
    await screen.findAllByText('Subject 1')

    fireEvent.click(screen.getByRole('button', { name: /Recipients/i }))
    await screen.findByText('me@y.com')

    fireEvent.change(screen.getByPlaceholderText('Search recipients…'), { target: { value: 'shop' } })

    await waitFor(() => {
      expect(screen.queryByText('me@y.com')).not.toBeInTheDocument()
    })
    expect(screen.getByText('alias+shop@y.com')).toBeInTheDocument()
  })

  it('resets the recipient drill-down and search when switching back to Subjects', async () => {
    renderView()
    await screen.findAllByText('Subject 1')

    fireEvent.click(screen.getByRole('button', { name: /Recipients/i }))
    fireEvent.click(await screen.findByText('me@y.com'))
    await screen.findByText('All recipients')

    fireEvent.click(screen.getByRole('button', { name: /Subjects/i }))

    expect(screen.queryByText('All recipients')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(mockMessages).toHaveBeenLastCalledWith('f1', undefined, undefined)
    })
  })
})
