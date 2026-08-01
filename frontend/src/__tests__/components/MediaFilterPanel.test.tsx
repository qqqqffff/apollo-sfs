import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MediaFilterPanel, summarizeMediaFilters } from '../../components/MediaFilterPanel'
import { EMPTY_MEDIA_FILTERS } from '../../types/api'
import type { MediaFilters, RecognitionGroup } from '../../types/api'

let mockGroups: RecognitionGroup[] = []

jest.mock('../../api/recognition', () => ({
  recognitionGroupsQueryOptions: (collectionId: string, kind?: string, labeled?: boolean) => ({
    queryKey: ['recognition', collectionId, 'groups', kind ?? 'all', labeled ?? false],
    queryFn: () => Promise.resolve({ groups: mockGroups }),
  }),
}))

function makeGroup(overrides: Partial<RecognitionGroup> = {}): RecognitionGroup {
  return {
    id: 'g1',
    user_id: 'u1',
    collection_id: 'coll-1',
    kind: 'face',
    auto_label: 'Person 1',
    member_count: 3,
    file_count: 4,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

function renderPanel(props: Partial<React.ComponentProps<typeof MediaFilterPanel>> = {}) {
  const onApply = jest.fn()
  const onClose = jest.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MediaFilterPanel
        collectionId="coll-1"
        value={EMPTY_MEDIA_FILTERS}
        selectionMode={false}
        recognitionEnabled={false}
        onApply={onApply}
        onClose={onClose}
        {...props}
      />
    </QueryClientProvider>,
  )
  return { onApply, onClose }
}

beforeEach(() => {
  mockGroups = []
})

describe('MediaFilterPanel', () => {
  it('renders every filter facet the collection supports', () => {
    renderPanel()
    expect(screen.getByText('Date taken')).toBeInTheDocument()
    expect(screen.getByText('Upload date')).toBeInTheDocument()
    expect(screen.getByText('Upload source')).toBeInTheDocument()
    expect(screen.getByText('Media type')).toBeInTheDocument()
    expect(screen.getByText('Photos')).toBeInTheDocument()
    expect(screen.getByText('Videos')).toBeInTheDocument()
    expect(screen.getByText('Google Photos backup')).toBeInTheDocument()
  })

  it('hides the labels section when recognition is off', () => {
    renderPanel()
    expect(screen.queryByText(/Labeled people/)).not.toBeInTheDocument()
  })

  it('lists labeled recognition groups when recognition is on', async () => {
    mockGroups = [makeGroup({ id: 'g1', user_label: 'Ada' }), makeGroup({ id: 'g2', user_label: 'Rex', kind: 'pet' })]
    renderPanel({ recognitionEnabled: true })

    expect(await screen.findByText('Ada (4)')).toBeInTheDocument()
    expect(screen.getByText('Rex (4)')).toBeInTheDocument()
  })

  it('applies the facets the user picked', () => {
    const { onApply } = renderPanel()

    fireEvent.click(screen.getByText('Videos'))
    fireEvent.click(screen.getByText('Web upload'))
    fireEvent.change(screen.getByLabelText('Date taken after'), { target: { value: '2024-02-01' } })
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }))

    expect(onApply).toHaveBeenCalledTimes(1)
    const applied: MediaFilters = onApply.mock.calls[0][0]
    expect(applied.mediaTypes).toEqual(['video'])
    expect(applied.sources).toEqual(['web'])
    expect(applied.takenAfter).toBe('2024-02-01')
  })

  it('opens seeded with the filter already applied to the view', () => {
    const { onApply } = renderPanel({
      value: { ...EMPTY_MEDIA_FILTERS, mediaTypes: ['image'], takenBefore: '2024-05-05' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
    const applied: MediaFilters = onApply.mock.calls[0][0]
    expect(applied.mediaTypes).toEqual(['image'])
    expect(applied.takenBefore).toBe('2024-05-05')
  })

  it('toggles a facet back off when clicked twice', () => {
    const { onApply } = renderPanel()
    fireEvent.click(screen.getByText('Photos'))
    fireEvent.click(screen.getByText('Photos'))
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
    expect(onApply.mock.calls[0][0].mediaTypes).toEqual([])
  })

  it('clears every facet with Clear all', () => {
    const { onApply } = renderPanel({ value: { ...EMPTY_MEDIA_FILTERS, sources: ['web'], groupIds: ['g1'] } })
    fireEvent.click(screen.getByText('Clear all'))
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
    expect(onApply.mock.calls[0][0]).toEqual(EMPTY_MEDIA_FILTERS)
  })

  it('becomes a selection tool in selection mode', async () => {
    const { onApply } = renderPanel({ selectionMode: true, selectedCount: 3 })

    expect(screen.getByText('Select by filter')).toBeInTheDocument()
    expect(screen.getByText('3 selected')).toBeInTheDocument()

    const selectMatching = screen.getByRole('button', { name: 'Select matching' })
    // Nothing picked yet — there is no match set to select.
    expect(selectMatching).toBeDisabled()

    fireEvent.click(screen.getByText('Videos'))
    await waitFor(() => expect(selectMatching).toBeEnabled())
    fireEvent.click(selectMatching)
    expect(onApply.mock.calls[0][0].mediaTypes).toEqual(['video'])
  })

  it('closes on Escape', () => {
    const { onClose } = renderPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('summarizeMediaFilters', () => {
  it('describes an empty filter as all media', () => {
    expect(summarizeMediaFilters(EMPTY_MEDIA_FILTERS)).toBe('All media')
  })

  it('joins a date range into one phrase', () => {
    expect(summarizeMediaFilters({ ...EMPTY_MEDIA_FILTERS, takenAfter: '2024-01-01', takenBefore: '2024-02-01' }))
      .toBe('taken 2024-01-01 → 2024-02-01')
  })

  it('describes an open-ended bound', () => {
    expect(summarizeMediaFilters({ ...EMPTY_MEDIA_FILTERS, uploadedBefore: '2024-02-01' }))
      .toBe('uploaded before 2024-02-01')
  })

  it('uses human labels for sources and media types', () => {
    const summary = summarizeMediaFilters({
      ...EMPTY_MEDIA_FILTERS,
      sources: ['google_photos'],
      mediaTypes: ['image'],
    })
    expect(summary).toBe('Google Photos backup · Photos')
  })

  it('resolves group ids through the supplied names', () => {
    const names = new Map([['g1', 'Ada']])
    expect(summarizeMediaFilters({ ...EMPTY_MEDIA_FILTERS, groupIds: ['g1'] }, names)).toBe('Ada')
  })
})
