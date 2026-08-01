import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MediaCollectionView } from '../../components/MediaCollectionView'
import { NotificationProvider } from '../../context/NotificationContext'
import type { File, Folder, FolderContents } from '../../types/api'

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('../../api/folders', () => ({
  getMediaFolder: jest.fn(),
  getMediaFileIds: jest.fn(),
  createFolder: jest.fn(),
}))

jest.mock('../../api/files', () => ({
  deleteFile: jest.fn().mockResolvedValue({}),
  hideFile: jest.fn().mockResolvedValue({}),
  unhideFile: jest.fn().mockResolvedValue({}),
  previewUrl: (id: string) => `/preview/${id}`,
  streamUrl: (id: string) => `/stream/${id}`,
  downloadUrl: (id: string) => `/download/${id}`,
}))

jest.mock('../../api/favorites', () => ({
  favoriteFile: jest.fn().mockResolvedValue({}),
  unfavoriteFile: jest.fn().mockResolvedValue({}),
  favoritesQueryOptions: {
    queryKey: ['favorites'],
    queryFn: () => Promise.resolve({ files: [], folders: [] }),
  },
  favoriteFolder: jest.fn(),
  unfavoriteFolder: jest.fn(),
  getFavorites: jest.fn().mockResolvedValue({ files: [], folders: [] }),
}))

jest.mock('../../api/collections', () => ({
  copyToCollection: jest.fn().mockResolvedValue({}),
  removeFromCollection: jest.fn().mockResolvedValue({}),
}))

jest.mock('../../api/devices', () => ({
  listDevices: jest.fn().mockResolvedValue({ items: [] }),
}))

jest.mock('../../api/me', () => ({
  meQueryOptions: {
    queryKey: ['me'],
    queryFn: () => Promise.resolve({
      username: 'alice',
      is_premium: true,
      is_admin: false,
      storage_used_bytes: 0,
      storage_quota_bytes: 1024,
    }),
  },
}))

jest.mock('../../api/storage', () => ({
  listMyServers: jest.fn().mockResolvedValue([]),
  resolveDrive: () => ({ drive: null, isPinned: false }),
}))

let mockRecognitionEnabled = false

jest.mock('../../api/recognition', () => ({
  recognitionStatusQueryOptions: (collectionId: string) => ({
    queryKey: ['recognition', collectionId, 'status'],
    queryFn: () => Promise.resolve({
      enabled: mockRecognitionEnabled,
      service_available: true,
      counts: { pending: 0, processing: 0, done: 0, failed: 0, skipped: 0 },
      groups: { face: 0, pet: 0, object: 0 },
      storage_bytes: 0,
    }),
    retry: false,
  }),
  recognitionGroupsQueryOptions: (collectionId: string, kind?: string, labeled?: boolean) => ({
    queryKey: ['recognition', collectionId, 'groups', kind ?? 'all', labeled ?? false],
    queryFn: () => Promise.resolve({ groups: [] }),
  }),
}))

jest.mock('../../hooks/useFileUpload', () => ({
  useFileUpload: () => ({
    progress: {
      status: 'idle', items: [], totalBytes: 0, loadedBytes: 0, speedBps: 0, succeeded: 0, failed: 0,
    },
    startUpload: jest.fn(),
    dismiss: jest.fn(),
  }),
}))

import { getMediaFolder, getMediaFileIds } from '../../api/folders'
import { hideFile } from '../../api/files'

const mockGetMediaFolder = getMediaFolder as jest.Mock
const mockGetMediaFileIds = getMediaFileIds as jest.Mock
const mockHideFile = hideFile as jest.Mock

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeFile(i: number, over: Partial<File> = {}): File {
  return {
    id: `f${i}`,
    user_id: 'u1',
    folder_id: 'col-1',
    name: `photo-${i}.jpg`,
    mime_type: 'image/jpeg',
    size_bytes: 1000,
    taken_at: '2024-01-0' + ((i % 9) + 1) + 'T00:00:00Z',
    hidden: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    source: 'web',
    ...over,
  }
}

const collection: Folder = {
  id: 'col-1',
  user_id: 'u1',
  parent_id: null,
  name: 'Photos',
  kind: 'media',
  size_bytes: 0,
  drive_id: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
} as Folder

function page(files: File[], nextToken = ''): FolderContents {
  return {
    folder: collection,
    subfolders: { items: [], next_token: '' },
    files: { items: files, next_token: nextToken },
  }
}

function renderView(props: Partial<React.ComponentProps<typeof MediaCollectionView>> = {}) {
  const handlers = {
    onBack: jest.fn(),
    onOpenFolder: jest.fn(),
    onOpenFile: jest.fn(),
    onNavigateFile: jest.fn(),
    onCloseFile: jest.fn(),
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <NotificationProvider>
        <MediaCollectionView
          folderId="col-1"
          folder={collection}
          readOnly={false}
          {...handlers}
          {...props}
        />
      </NotificationProvider>
    </QueryClientProvider>,
  )
  return { ...handlers, ...view, client }
}

// The tile's name appears on both the thumbnail button and the caption, so
// every lookup goes through the first (clickable) match.
function getTile(name: string): HTMLElement {
  return screen.getAllByTitle(name)[0]
}
async function findTile(name: string): Promise<HTMLElement> {
  return (await screen.findAllByTitle(name))[0]
}

// pages wires the listing mock up as a real cursor chain, so the infinite
// query terminates instead of re-serving page one forever.
function pages(...chunks: File[][]) {
  mockGetMediaFolder.mockImplementation((_id: string, p: { fileCursor?: string }) => {
    const index = p.fileCursor ? Number(p.fileCursor.replace('cursor-', '')) : 0
    const isLast = index >= chunks.length - 1
    return Promise.resolve(page(chunks[index] ?? [], isLast ? '' : `cursor-${index + 1}`))
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRecognitionEnabled = false
  pages([makeFile(1), makeFile(2), makeFile(3)])
  mockGetMediaFileIds.mockResolvedValue({ file_ids: [], truncated: false })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MediaCollectionView sorting', () => {
  it('offers upload source as a sort criterion', async () => {
    renderView()
    const select = await screen.findByLabelText('Sort media')
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'Date taken', 'Date uploaded', 'Name', 'Upload source',
    ])
  })

  it('refetches sorted by upload source when picked', async () => {
    renderView()
    const select = await screen.findByLabelText('Sort media')
    fireEvent.change(select, { target: { value: 'source' } })

    await waitFor(() => {
      expect(mockGetMediaFolder).toHaveBeenCalledWith('col-1', expect.objectContaining({ sort: 'source' }))
    })
  })
})

describe('MediaCollectionView infinite scroll', () => {
  it('requests a full page rather than the server default', async () => {
    renderView()
    await waitFor(() => expect(mockGetMediaFolder).toHaveBeenCalled())
    expect(mockGetMediaFolder.mock.calls[0][1]).toEqual(expect.objectContaining({ fileLimit: 128 }))
  })

  it('pulls the next page in on its own once the render window reaches the end', async () => {
    pages([makeFile(1), makeFile(2)], [makeFile(3)])

    renderView()

    // No "Load more" button to press — the second page is fetched because the
    // virtual window (viewport + 2 screens of overscan) already covers it.
    await waitFor(() => {
      expect(mockGetMediaFolder).toHaveBeenCalledWith('col-1', expect.objectContaining({ fileCursor: 'cursor-1' }))
    })
    expect(await findTile('photo-3.jpg')).toBeInTheDocument()
  })

  it('holds unloaded items open with placeholder tiles', async () => {
    // Second page never resolves, so the grid stays in "more to come" state.
    mockGetMediaFolder.mockImplementation((_id: string, p: { fileCursor?: string }) =>
      p.fileCursor
        ? new Promise(() => {})
        : Promise.resolve(page([makeFile(1), makeFile(2)], 'cursor-1')),
    )
    const { container } = renderView()

    await findTile('photo-1.jpg')
    // One placeholder row's worth of skeleton cells keeps the grid's height
    // (and so the scrollbar) stable while the next page is in flight.
    await waitFor(() => {
      expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
    })
  })

  it('reserves scroll height for every row, not just the rendered ones', async () => {
    pages(Array.from({ length: 40 }, (_, i) => makeFile(i + 1)))
    const { container } = renderView()

    await findTile('photo-1.jpg')
    const grid = container.querySelector('div.relative[style*="height"]') as HTMLElement
    expect(grid).toBeTruthy()
    expect(parseFloat(grid.style.height)).toBeGreaterThan(0)
  })
})

describe('MediaCollectionView mobile controls drawer', () => {
  it('closes the controls drawer when Filter is pressed, so the filter modal is not hidden behind it', async () => {
    const { container } = renderView()
    await findTile('photo-1.jpg')

    fireEvent.click(screen.getByLabelText('Open collection controls'))
    // The backdrop only exists in the DOM while the drawer is open.
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBe(1)

    fireEvent.click(screen.getByTitle('Filter this collection'))

    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBe(0)
    expect(await screen.findByRole('dialog', { name: 'Filter media' })).toBeInTheDocument()
  })

  it('also closes the drawer when Filter is pressed in selection mode', async () => {
    const { container } = renderView()
    await findTile('photo-1.jpg')

    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByLabelText('Open collection controls'))
    fireEvent.click(screen.getByTitle('Select items by filter'))

    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBe(0)
    expect(await screen.findByText('Select by filter')).toBeInTheDocument()
  })
})

describe('MediaCollectionView selection', () => {
  it('selects instead of opening while selection mode is on', async () => {
    const { onOpenFile } = renderView()
    await findTile('photo-1.jpg')

    // Off by default: a tap opens the viewer.
    fireEvent.click(getTile('photo-1.jpg'))
    expect(onOpenFile).toHaveBeenCalledWith('f1')
    onOpenFile.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(getTile('photo-1.jpg'))

    expect(onOpenFile).not.toHaveBeenCalled()
    expect(await screen.findByText('1 selected')).toBeInTheDocument()
  })

  it('toggles an item back out of the selection', async () => {
    renderView()
    await findTile('photo-1.jpg')
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))

    fireEvent.click(getTile('photo-1.jpg'))
    fireEvent.click(getTile('photo-2.jpg'))
    expect(await screen.findByText('2 selected')).toBeInTheDocument()

    fireEvent.click(getTile('photo-2.jpg'))
    expect(await screen.findByText('1 selected')).toBeInTheDocument()
  })

  it('runs a bulk action across the whole selection', async () => {
    renderView()
    await findTile('photo-1.jpg')
    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(getTile('photo-1.jpg'))
    fireEvent.click(getTile('photo-2.jpg'))

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))

    await waitFor(() => expect(mockHideFile).toHaveBeenCalledTimes(2))
    expect(mockHideFile).toHaveBeenCalledWith('f1')
    expect(mockHideFile).toHaveBeenCalledWith('f2')
  })

  it('clears the selection when selection mode is turned off', async () => {
    renderView()
    await findTile('photo-1.jpg')
    const toggle = screen.getByRole('button', { name: 'Select' })
    fireEvent.click(toggle)
    fireEvent.click(getTile('photo-1.jpg'))
    expect(await screen.findByText('1 selected')).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
  })
})

describe('MediaCollectionView filtering', () => {
  it('narrows the listing when a filter is applied while browsing', async () => {
    renderView()
    await findTile('photo-1.jpg')

    fireEvent.click(screen.getByRole('button', { name: /Filter/ }))
    fireEvent.click(await screen.findByText('Videos'))
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }))

    await waitFor(() => {
      expect(mockGetMediaFolder).toHaveBeenCalledWith(
        'col-1',
        expect.objectContaining({ filters: expect.objectContaining({ mediaTypes: ['video'] }) }),
      )
    })
    // The badge on the toolbar button reflects the one active facet.
    expect(await screen.findByText(/Filtered:/)).toBeInTheDocument()
  })

  it('selects every match instead of filtering when selection mode is on', async () => {
    mockGetMediaFileIds.mockResolvedValue({ file_ids: ['f1', 'f2', 'f9'], truncated: false })
    renderView()
    await findTile('photo-1.jpg')

    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }))
    fireEvent.click(await screen.findByText('Videos'))
    fireEvent.click(screen.getByRole('button', { name: 'Select matching' }))

    await waitFor(() => {
      expect(mockGetMediaFileIds).toHaveBeenCalledWith(
        'col-1',
        expect.objectContaining({ filters: expect.objectContaining({ mediaTypes: ['video'] }) }),
      )
    })
    // Ids outside the loaded page count too — the match set comes from the
    // server. Both the toolbar and the still-open panel echo the count.
    expect((await screen.findAllByText('3 selected')).length).toBeGreaterThan(0)
    // The view itself is untouched: still no filter on the listing query.
    expect(mockGetMediaFolder).not.toHaveBeenCalledWith(
      'col-1',
      expect.objectContaining({ filters: expect.objectContaining({ mediaTypes: ['video'] }) }),
    )
  })

  it('unions several filters into one selection', async () => {
    renderView()
    await findTile('photo-1.jpg')

    fireEvent.click(screen.getByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }))

    // Scope the facet clicks to the dialog — the applied-filter chips behind
    // it carry the same labels.
    const panel = within(await screen.findByRole('dialog'))

    mockGetMediaFileIds.mockResolvedValueOnce({ file_ids: ['f1', 'f2'], truncated: false })
    fireEvent.click(panel.getByText('Videos'))
    fireEvent.click(panel.getByRole('button', { name: 'Select matching' }))
    expect((await screen.findAllByText('2 selected')).length).toBeGreaterThan(0)

    // A second, different filter adds its matches on top (f2 already in).
    mockGetMediaFileIds.mockResolvedValueOnce({ file_ids: ['f2', 'f7'], truncated: false })
    fireEvent.click(panel.getByText('Videos')) // untick
    fireEvent.click(panel.getByText('Web upload'))
    fireEvent.click(panel.getByRole('button', { name: 'Select matching' }))

    expect((await screen.findAllByText('3 selected')).length).toBeGreaterThan(0)
    expect(mockGetMediaFileIds).toHaveBeenCalledTimes(2)
    // One chip per filter the selection was built from.
    expect(screen.getByText('Selected by:')).toBeInTheDocument()
  })
})

describe('MediaCollectionView scroll restoration', () => {
  it('scrolls back to the item that was open when the viewer closes', async () => {
    const scrollTo = jest.fn()
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1 })

    pages(Array.from({ length: 40 }, (_, i) => makeFile(i + 1)))

    const { rerender, client } = renderView({ activeFileId: 'f30' })
    await findTile('photo-1.jpg')
    scrollTo.mockClear()

    // Closing the viewer drops the file search param.
    rerender(
      <QueryClientProvider client={client}>
        <NotificationProvider>
          <MediaCollectionView
            folderId="col-1"
            folder={collection}
            readOnly={false}
            onBack={jest.fn()}
            onOpenFolder={jest.fn()}
            onOpenFile={jest.fn()}
            onNavigateFile={jest.fn()}
            onCloseFile={jest.fn()}
          />
        </NotificationProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => expect(scrollTo).toHaveBeenCalled())
    // f30 is the 30th item — row 8 of a 4-column grid — so the restore scrolls
    // deep into the list rather than back to the top.
    const target = scrollTo.mock.calls[scrollTo.mock.calls.length - 1][0]
    expect(typeof target).toBe('object')
    expect(target.top).toBeGreaterThan(0)

    jest.restoreAllMocks()
  })
})
