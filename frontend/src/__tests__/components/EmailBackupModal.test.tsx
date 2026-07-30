import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EmailBackupModal } from '../../components/EmailBackupModal'
import type { ProviderEmailItem } from '../../api/emailProviders'

const ensureEmailBackupFolder = jest.fn()
const backupEmailEntries = jest.fn()

jest.mock('../../api/emailBackup', () => ({
  ...jest.requireActual('../../api/emailBackup'),
  ensureEmailBackupFolder: (...args: unknown[]) => ensureEmailBackupFolder(...args),
  backupEmailEntries: (...args: unknown[]) => backupEmailEntries(...args),
  completeEmailBackupRun: jest.fn().mockResolvedValue({}),
  deleteProviderMessages: jest.fn().mockResolvedValue({ failed: 0 }),
  removeBackedUpMessages: jest.fn().mockResolvedValue({ removed: 0, failed: 0 }),
}))

function makeItem(id: string, overrides: Partial<ProviderEmailItem> = {}): ProviderEmailItem {
  return {
    id,
    provider: 'gmail',
    from: `Sender ${id} <${id}@x.com>`,
    fromAddr: `${id}@x.com`,
    to: 'me@y.com',
    subject: `Subject ${id}`,
    snippet: '',
    date: '2026-07-01T00:00:00Z',
    starred: false,
    unread: false,
    hasAttachments: false,
    sizeEstimate: 1024,
    ...overrides,
  }
}

function renderModal(props: Partial<React.ComponentProps<typeof EmailBackupModal>> = {}) {
  const items = props.items ?? [
    makeItem('a', { starred: true }),
    makeItem('b'),
    makeItem('c'),
    makeItem('d'),
  ]
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={client}>
      <EmailBackupModal
        provider="gmail"
        accessToken="token"
        accountEmail="user@example.com"
        items={items}
        fetching={false}
        fetchProgress={null}
        onStopFetching={jest.fn()}
        quotaBytes={10 * 1024 ** 3}
        usedBytes={0}
        myServers={[]}
        onClose={jest.fn()}
        onDone={jest.fn()}
        onStartBackground={jest.fn()}
        {...props}
      />
    </QueryClientProvider>,
  )
  return { ...utils, items }
}

beforeEach(() => {
  jest.clearAllMocks()
  localStorage.clear()
  // Run the backup inline rather than handing it to the background card.
  localStorage.setItem('apollo_ebackup_background', 'false')
  ensureEmailBackupFolder.mockResolvedValue({ folder: { id: 'folder-1' }, created: true })
  backupEmailEntries.mockResolvedValue({
    uploaded: 0, duplicates: 0, errors: 0, cancelled: false,
    backedUpIds: [], uploadedFileIds: [], uploadedMessageIds: [],
  })
})

describe('EmailBackupModal selection', () => {
  it('selects everything by default', () => {
    renderModal()
    expect(screen.getByText('4 of 4 emails selected')).toBeInTheDocument()
  })

  it('clears the whole selection when None is pressed under a filter', async () => {
    renderModal()

    // Narrow the table to the one starred email, then clear the selection.
    fireEvent.click(screen.getByRole('button', { name: 'Starred' }))
    expect(screen.getByText('1 shown')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'None' }))

    // Regression: clearing used to drop only the visible row, leaving the
    // three filtered-out emails selected and part of the backup.
    expect(screen.getByText('0 of 4 emails selected')).toBeInTheDocument()
  })

  it('backs up only the emails picked after clearing the selection', async () => {
    renderModal()

    fireEvent.click(screen.getByRole('button', { name: 'Starred' }))
    fireEvent.click(screen.getByRole('button', { name: 'None' }))
    fireEvent.click(screen.getByRole('button', { name: 'Starred' }))   // back to all four rows
    // Pick two of them.
    fireEvent.click(screen.getByRole('button', { name: 'Select Subject b' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select Subject d' }))

    fireEvent.click(screen.getByRole('button', { name: /Back Up 2 Emails/ }))

    await waitFor(() => expect(backupEmailEntries).toHaveBeenCalled())
    const [selectedItems] = backupEmailEntries.mock.calls[0]
    expect((selectedItems as ProviderEmailItem[]).map((i) => i.id)).toEqual(['b', 'd'])
  })

  it('warns when the filter hides part of the selection', () => {
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Starred' }))
    expect(screen.getByText(/3 selected emails are hidden by the current filters/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Deselect' }))
    expect(screen.getByText('1 of 4 emails selected')).toBeInTheDocument()
  })
})

describe('EmailBackupModal streaming retrieval', () => {
  it('shows retrieval progress and blocks the backup until it finishes', () => {
    renderModal({ fetching: true, fetchProgress: { fetched: 4, fraction: 0.25 } })

    expect(screen.getByText(/Retrieving your emails — 4 loaded so far/)).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument()
    const backUp = screen.getByRole('button', { name: /Retrieving emails…/ })
    expect(backUp).toBeDisabled()
  })

  it('selects messages that stream in later, until the user picks their own', () => {
    const { rerender } = renderModal({ items: [makeItem('a')] })
    expect(screen.getByText('1 of 1 email selected')).toBeInTheDocument()

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const props = {
      provider: 'gmail' as const,
      accessToken: 'token',
      accountEmail: 'user@example.com',
      fetching: false,
      fetchProgress: null,
      onStopFetching: jest.fn(),
      quotaBytes: 10 * 1024 ** 3,
      usedBytes: 0,
      myServers: [],
      onClose: jest.fn(),
      onDone: jest.fn(),
      onStartBackground: jest.fn(),
    }
    rerender(
      <QueryClientProvider client={client}>
        <EmailBackupModal {...props} items={[makeItem('a'), makeItem('b')]} />
      </QueryClientProvider>,
    )
    expect(screen.getByText('2 of 2 emails selected')).toBeInTheDocument()

    // Once the user curates the selection, later arrivals stay out of it.
    fireEvent.click(screen.getByRole('button', { name: 'Deselect Subject b' }))
    rerender(
      <QueryClientProvider client={client}>
        <EmailBackupModal {...props} items={[makeItem('a'), makeItem('b'), makeItem('c')]} />
      </QueryClientProvider>,
    )
    expect(screen.getByText('1 of 3 emails selected')).toBeInTheDocument()
  })
})

describe('EmailBackupModal run controls', () => {
  it('offers pause and cancel while a backup is in flight', async () => {
    // Hold the run open so the uploading phase stays on screen.
    let resolveRun: (v: unknown) => void = () => {}
    backupEmailEntries.mockImplementation(() => new Promise((r) => { resolveRun = r }))

    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /Back Up 4 Emails/ }))

    const pause = await screen.findByRole('button', { name: /Pause/ })
    const cancel = screen.getByRole('button', { name: /Cancel/ })
    expect(pause).toBeInTheDocument()

    // Cancel pauses first and asks what to do with what already landed.
    fireEvent.click(cancel)
    const dialog = await screen.findByText('Cancel this backup?')
    expect(dialog).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Remove what was backed up/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Keep them/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Keep them/ }))
    resolveRun({
      uploaded: 1, duplicates: 0, errors: 0, cancelled: true,
      backedUpIds: ['a'], uploadedFileIds: ['f1'], uploadedMessageIds: ['row-1'],
    })
    expect(await screen.findByText(/Backup cancelled — 1 email kept\./)).toBeInTheDocument()
  })

  it('passes a control handle so the loop can be paused', async () => {
    backupEmailEntries.mockImplementation(() => new Promise(() => {}))

    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /Back Up 4 Emails/ }))
    await waitFor(() => expect(backupEmailEntries).toHaveBeenCalled())

    const opts = backupEmailEntries.mock.calls[0][4] as { control?: unknown; folderName?: string }
    expect(opts.control).toBeDefined()
    expect(opts.folderName).toBe('user@example.com')
  })
})

describe('EmailBackupModal quota card', () => {
  it('shows the selected size and projected usage', () => {
    renderModal()
    const card = screen.getByText('4 of 4 emails selected').closest('div')!
    expect(within(card).getByText('4 KB')).toBeInTheDocument()
  })
})
