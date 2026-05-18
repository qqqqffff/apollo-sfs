import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

const mockNavigate = jest.fn()
let mockSearch = { file: undefined as string | undefined, folder: undefined as string | undefined }

jest.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: any) => ({ options: opts }),
  useNavigate: () => mockNavigate,
  useSearch: () => mockSearch,
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

// Hook mocks
jest.mock('../../../hooks/useFileUpload', () => ({
  useFileUpload: () => ({ progress: null, startUpload: jest.fn(), dismiss: jest.fn() }),
}))
jest.mock('../../../hooks/useDragDrop', () => ({
  useDragDrop: (_cb: any) => ({ isDragging: false }),
}))
jest.mock('../../../hooks/useFileDrag', () => ({
  useFileDrag: () => ({
    draggingFileId: null,
    draggingFolderId: null,
    dragOverFolderId: null,
    getFileDragHandlers:   () => ({}),
    getFolderDragHandlers: () => ({}),
    getFolderDropHandlers: () => ({}),
  }),
}))
jest.mock('../../../hooks/useSort', () => ({
  useSort: () => ({ sort: { field: 'name', direction: 'asc' }, onSort: jest.fn() }),
  sortedFolders: (fs: any[]) => fs,
  sortedFiles:   (fs: any[]) => fs,
}))
jest.mock('../../../hooks/useFavorites', () => ({
  useFavorites: () => ({
    favoriteFileIds:   new Set<string>(),
    favoriteFolderIds: new Set<string>(),
    toggleFile:   jest.fn(),
    toggleFolder: jest.fn(),
  }),
}))

let mockContentsReturnValue = {
  folder: null as any,
  folders: [] as any[],
  files: [] as any[],
  isLoading: false,
  error: null as Error | null,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: jest.fn(),
}
jest.mock('../../../hooks/useInfiniteFolderContents', () => ({
  useInfiniteFolderContents: () => mockContentsReturnValue,
}))

// Component mocks
jest.mock('../../../components/FilePreviewModal', () => ({
  canPreview: () => false,
  FilePreviewModal: () => null,
}))
jest.mock('../../../components/UploadModal', () => ({
  UploadModal: ({ onCancel }: any) => (
    <div data-testid="upload-modal">
      <button onClick={onCancel}>Cancel upload</button>
    </div>
  ),
}))
jest.mock('../../../components/DeleteConfirmModal', () => ({
  DeleteConfirmModal: () => <div data-testid="delete-modal" />,
  readSkipDeleteCookie: () => false,
}))
jest.mock('../../../components/UploadToast', () => ({
  UploadToast: () => null,
}))
jest.mock('../../../components/SortControls', () => ({
  SortControls: () => <div data-testid="sort-controls" />,
}))
jest.mock('../../../components/SearchBar', () => ({
  SearchBar: ({ onChange }: any) => (
    <input
      data-testid="search-bar"
      placeholder="Search"
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

// API mocks
jest.mock('../../../api/folders', () => ({
  createFolder: jest.fn(),
  deleteFolder: jest.fn(),
  moveFolder:   jest.fn(),
}))
jest.mock('../../../api/files', () => ({
  deleteFile:      jest.fn(),
  downloadUrl:     (id: string) => `/api/v1/files/${id}/download`,
  fileQueryOptions: (id: string) => ({ queryKey: ['file', id], queryFn: jest.fn() }),
  moveFile:        jest.fn(),
}))
jest.mock('../../../api/me', () => ({
  meQueryOptions: { queryKey: ['me'], queryFn: jest.fn() },
}))

import { Route } from '../../../routes/_auth.client/index'
const Page = Route.options.component as React.ComponentType

const GB = 1024 ** 3
const USER = {
  username: 'alice',
  email: 'alice@example.com',
  is_admin: false,
  storage_used_bytes: 1 * GB,
  storage_quota_bytes: 10 * GB,
}
const FOLDERS = [
  { id: 'fold1', name: 'Photos',    parent_id: null },
  { id: 'fold2', name: 'Documents', parent_id: null },
]
const FILES = [
  { id: 'fi1', name: 'report.pdf', size_bytes: 512 * 1024, mime_type: 'application/pdf' },
  { id: 'fi2', name: 'note.txt',   size_bytes: 1024,       mime_type: 'text/plain' },
]

function setup(overrides: Partial<typeof mockContentsReturnValue> = {}, userOverride: typeof USER | null = USER) {
  mockContentsReturnValue = {
    folder: null,
    folders: FOLDERS,
    files: FILES,
    isLoading: false,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(),
    ...overrides,
  }
  mockQuery.mockReturnValue({ data: userOverride })
  mockMutation.mockReturnValue({ mutate: jest.fn(), isPending: false })
  mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn() })
  mockSearch = { file: undefined, folder: undefined }
  return render(<Page />)
}

describe('Client Files (index) page', () => {
  beforeEach(() => {
    mockNavigate.mockReset()
    mockNotify.mockReset()
  })

  test('renders My Files heading at root', () => {
    setup()
    expect(screen.getByRole('heading', { name: /my files/i })).toBeInTheDocument()
  })

  test('shows loading state', () => {
    setup({ isLoading: true, folders: [], files: [] })
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  test('shows error state', () => {
    setup({ error: new Error('fail'), folders: [], files: [] })
    expect(screen.getByText(/failed to load files/i)).toBeInTheDocument()
  })

  test('renders folder names', () => {
    setup()
    expect(screen.getByText('Photos')).toBeInTheDocument()
    expect(screen.getByText('Documents')).toBeInTheDocument()
  })

  test('renders file names', () => {
    setup()
    expect(screen.getByText('report.pdf')).toBeInTheDocument()
    expect(screen.getByText('note.txt')).toBeInTheDocument()
  })

  test('renders New folder and Upload buttons', () => {
    setup()
    expect(screen.getByRole('button', { name: /new folder/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /upload/i })).toBeInTheDocument()
  })

  test('clicking New folder shows folder name input', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /new folder/i }))
    expect(screen.getByPlaceholderText(/folder name/i)).toBeInTheDocument()
  })

  test('Escape cancels folder creation', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /new folder/i }))
    fireEvent.keyDown(screen.getByPlaceholderText(/folder name/i), { key: 'Escape' })
    expect(screen.queryByPlaceholderText(/folder name/i)).not.toBeInTheDocument()
  })

  test('shows empty state when no files or folders', () => {
    setup({ folders: [], files: [] })
    expect(screen.getByText(/no files yet/i)).toBeInTheDocument()
  })

  test('shows empty folder message in a sub-folder', () => {
    mockContentsReturnValue = {
      folder: { id: 'fold1', name: 'Photos', parent_id: null },
      folders: [],
      files: [],
      isLoading: false,
      error: null,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: jest.fn(),
    }
    mockQuery.mockReturnValue({ data: USER })
    mockMutation.mockReturnValue({ mutate: jest.fn(), isPending: false })
    mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn() })
    mockSearch = { file: undefined, folder: 'fold1' }
    render(<Page />)
    expect(screen.getByText(/this folder is empty/i)).toBeInTheDocument()
  })

  test('shows Load more button when hasNextPage', () => {
    setup({ hasNextPage: true })
    expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument()
  })

  test('does not show Load more when no next page', () => {
    setup()
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
  })

  test('renders quota bar when user is present', () => {
    setup()
    expect(screen.getByText(/used/)).toBeInTheDocument()
    expect(screen.getByText(/quota/)).toBeInTheDocument()
  })

  test('delete buttons are present for each item', () => {
    setup()
    expect(screen.getAllByRole('button', { name: /delete/i })).toHaveLength(4)
  })
})
