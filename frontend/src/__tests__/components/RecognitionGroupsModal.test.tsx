import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RecognitionGroupsModal } from '../../components/RecognitionGroupsModal'
import { NotificationProvider } from '../../context/NotificationContext'
import type { RecognitionGroup, RecognitionStatus } from '../../types/api'

const mockStatus: RecognitionStatus = {
  enabled: true,
  service_available: true,
  counts: { pending: 2, processing: 1, done: 7, failed: 0, skipped: 0 },
  groups: { face: 2, pet: 1, object: 1 },
  storage_bytes: 5 * 1024 * 1024,
}

function makeGroup(overrides: Partial<RecognitionGroup> = {}): RecognitionGroup {
  return {
    id: 'g1',
    user_id: 'u1',
    collection_id: 'coll-1',
    kind: 'face',
    auto_label: 'Person 1',
    member_count: 3,
    file_count: 3,
    cover_detection_id: 'det-1',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

let mockGroups: RecognitionGroup[] = []

jest.mock('../../api/recognition', () => ({
  recognitionStatusQueryOptions: (collectionId: string) => ({
    queryKey: ['recognition', collectionId, 'status'],
    queryFn: () => Promise.resolve(mockStatus),
    retry: false,
  }),
  recognitionGroupsQueryOptions: (collectionId: string, kind?: string, labeled?: boolean) => ({
    queryKey: ['recognition', collectionId, 'groups', kind ?? 'all', labeled ?? false],
    queryFn: () => Promise.resolve({ groups: mockGroups }),
  }),
  getGroupFiles: jest.fn().mockResolvedValue({ items: [], next_token: '' }),
  renameGroup: jest.fn().mockResolvedValue({}),
  mergeGroups: jest.fn().mockResolvedValue({}),
  deleteGroup: jest.fn().mockResolvedValue({ ok: true }),
  detectionThumbUrl: (id: string) => `/api/v1/recognition/detections/${id}/thumb`,
}))

jest.mock('../../api/files', () => ({
  previewUrl: (id: string) => `/api/v1/files/${id}/preview`,
}))

import { mergeGroups, renameGroup } from '../../api/recognition'

function renderModal(props: Partial<Parameters<typeof RecognitionGroupsModal>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <NotificationProvider>
        <RecognitionGroupsModal
          collectionId="coll-1"
          onOpenFile={jest.fn()}
          onClose={jest.fn()}
          {...props}
        />
      </NotificationProvider>
    </QueryClientProvider>,
  )
}

describe('RecognitionGroupsModal', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGroups = []
  })

  test('shows the indexing status chip and storage note', async () => {
    renderModal()
    expect(await screen.findByText(/indexing 7\/10/i)).toBeInTheDocument()
    expect(await screen.findByText(/recognition data uses 5\.0 MB/i)).toBeInTheDocument()
  })

  test('renders group tiles with labels and counts', async () => {
    mockGroups = [
      makeGroup(),
      makeGroup({ id: 'g2', kind: 'pet', class_label: 'cat', auto_label: 'Pet 1 (cat)', user_label: 'Whiskers', file_count: 5 }),
    ]
    renderModal()
    expect(await screen.findByText('Person 1')).toBeInTheDocument()
    expect(screen.getByText('Whiskers')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
  })

  test('inline rename fires the mutation with the typed label', async () => {
    mockGroups = [makeGroup()]
    renderModal()
    fireEvent.click(await screen.findByLabelText('Rename Person 1'))
    const input = screen.getByPlaceholderText('Person 1')
    fireEvent.change(input, { target: { value: 'Grandma' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(renameGroup).toHaveBeenCalledWith('g1', 'Grandma'))
  })

  test('merge requires at least two same-kind groups', async () => {
    mockGroups = [
      makeGroup(),
      makeGroup({ id: 'g2', auto_label: 'Person 2' }),
      makeGroup({ id: 'g3', kind: 'object', class_label: 'car', auto_label: 'car' }),
    ]
    renderModal()

    fireEvent.click(await screen.findByLabelText('Select Person 1'))
    fireEvent.click(screen.getByLabelText('Select car'))
    // face + object → merge disabled
    expect(screen.getByRole('button', { name: /merge/i })).toBeDisabled()
    expect(screen.getByText(/merge needs matching kinds/i)).toBeInTheDocument()

    // swap the object for the second face group → merge enabled, first selected wins as target
    fireEvent.click(screen.getByLabelText('Select car'))
    fireEvent.click(screen.getByLabelText('Select Person 2'))
    const mergeBtn = screen.getByRole('button', { name: /merge/i })
    expect(mergeBtn).toBeEnabled()
    fireEvent.click(mergeBtn)
    await waitFor(() => expect(mergeGroups).toHaveBeenCalledWith('g1', ['g2']))
  })

  test('labeled tab shows only-labeled empty state', async () => {
    renderModal()
    fireEvent.click(await screen.findByRole('button', { name: 'Labeled' }))
    expect(await screen.findByText(/label a group to make it searchable/i)).toBeInTheDocument()
  })

  test('deep link opens the group file grid', async () => {
    mockGroups = [makeGroup({ user_label: 'Grandma' })]
    renderModal({ initialGroupId: 'g1' })
    // Header shows the group name with a back button instead of the grid.
    expect(await screen.findByText('Grandma')).toBeInTheDocument()
    expect(await screen.findByText(/no files in this group/i)).toBeInTheDocument()
  })
})
