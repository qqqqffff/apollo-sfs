import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CollectionInfoModal } from '../../components/CollectionInfoModal'
import { NotificationProvider } from '../../context/NotificationContext'
import type { Folder, RecognitionStatus } from '../../types/api'

const mockStatus: RecognitionStatus = {
  enabled: false,
  service_available: true,
  counts: { pending: 0, processing: 0, done: 0, failed: 0, skipped: 0 },
  groups: { face: 0, pet: 0, object: 0 },
  storage_bytes: 0,
}

jest.mock('../../api/recognition', () => ({
  recognitionStatusQueryOptions: (collectionId: string, enabled = true) => ({
    queryKey: ['recognition', collectionId, 'status'],
    queryFn: () => Promise.resolve(mockStatus),
    enabled,
    retry: false,
  }),
  setRecognitionEnabled: jest.fn().mockResolvedValue({ enabled: true, files_enqueued: 12, freed_bytes: 0 }),
}))

import { setRecognitionEnabled } from '../../api/recognition'

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: 'coll-1',
    user_id: 'u1',
    parent_id: null,
    name: 'Family Photos',
    kind: 'media',
    size_bytes: 1024,
    drive_id: null,
    ai_recognition_enabled: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

function renderModal(props: Partial<Parameters<typeof CollectionInfoModal>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <NotificationProvider>
        <CollectionInfoModal
          folder={makeFolder()}
          isPremium
          readOnly={false}
          onClose={jest.fn()}
          {...props}
        />
      </NotificationProvider>
    </QueryClientProvider>,
  )
}

describe('CollectionInfoModal', () => {
  beforeEach(() => jest.clearAllMocks())

  test('shows the collection name and the AI recognition section', () => {
    renderModal()
    expect(screen.getByText('Family Photos')).toBeInTheDocument()
    expect(screen.getByText('AI recognition')).toBeInTheDocument()
  })

  test('disables the toggle and shows an upgrade hint for free users', () => {
    renderModal({ isPremium: false })
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(screen.getByText(/premium feature/i)).toBeInTheDocument()
  })

  test('enabling requires confirming the disclaimer first', async () => {
    renderModal()
    fireEvent.click(screen.getByRole('checkbox'))

    // Toggling shows the disclaimer, not an immediate API call.
    expect(setRecognitionEnabled).not.toHaveBeenCalled()
    expect(screen.getByText(/count toward your storage quota/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /enable ai recognition/i }))
    await waitFor(() => expect(setRecognitionEnabled).toHaveBeenCalledWith('coll-1', true, false))
  })

  test('cancelling the disclaimer makes no API call', () => {
    renderModal()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(setRecognitionEnabled).not.toHaveBeenCalled()
    expect(screen.queryByText(/count toward your storage quota/i)).not.toBeInTheDocument()
  })

  test('disabling offers the purge option and passes it through', async () => {
    renderModal({ folder: makeFolder({ ai_recognition_enabled: true }) })
    fireEvent.click(screen.getByRole('checkbox', { name: '' }))

    expect(screen.getByText(/stop indexing this collection/i)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/also delete groups, detections/i))
    fireEvent.click(screen.getByRole('button', { name: /disable & delete data/i }))
    await waitFor(() => expect(setRecognitionEnabled).toHaveBeenCalledWith('coll-1', false, true))
  })
})
