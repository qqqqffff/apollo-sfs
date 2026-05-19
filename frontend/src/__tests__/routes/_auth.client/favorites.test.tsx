import React from 'react'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

jest.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: any) => ({ options: opts }),
  Link: ({ children, to }: any) => <a href={to}>{children}</a>,
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

let mockImpersonatedUser: any = null
jest.mock('../../../context/ImpersonationContext', () => ({
  useImpersonation: () => ({ impersonatedUser: mockImpersonatedUser, impersonate: jest.fn(), clearImpersonation: jest.fn() }),
}))

jest.mock('../../../api/favorites', () => ({
  favoritesQueryOptions: { queryKey: ['favorites'], queryFn: jest.fn() },
  unfavoriteFile:   jest.fn(),
  unfavoriteFolder: jest.fn(),
}))

jest.mock('../../../api/admin', () => ({
  adminGetUserFavorites: jest.fn(),
}))

jest.mock('../../../components/FilePreviewModal', () => ({
  canPreview: () => false,
  FilePreviewModal: () => null,
}))

import { Route } from '../../../routes/_auth.client/favorites'
const Page = Route.options.component as React.ComponentType

const GB = 1024 ** 3

const FOLDERS = [
  { id: 'f1', name: 'Photos' },
  { id: 'f2', name: 'Documents' },
]
const FILES = [
  { id: 'fi1', name: 'report.pdf', size_bytes: 2 * GB, mime_type: 'application/pdf' },
  { id: 'fi2', name: 'image.png',  size_bytes: 1024,   mime_type: 'image/png' },
]

function setup(
  data: { files?: typeof FILES; folders?: typeof FOLDERS } | null = { files: FILES, folders: FOLDERS },
  overrides: { isLoading?: boolean } = {},
) {
  const { isLoading = false } = overrides
  // The component calls useQuery twice (own data + admin data), one enabled at a time.
  // mockReturnValue covers both calls with the same result shape.
  mockQuery.mockReturnValue({ data, isLoading })
  mockMutation.mockReturnValue({ mutate: jest.fn(), isPending: false })
  mockQueryClient.mockReturnValue({ invalidateQueries: jest.fn() })
  return render(<Page />)
}

describe('Client Favorites page', () => {
  beforeEach(() => {
    mockNotify.mockReset()
    mockImpersonatedUser = null
  })

  test('renders Favorites heading', () => {
    setup()
    expect(screen.getByRole('heading', { name: /favorites/i })).toBeInTheDocument()
  })

  test('shows loading state', () => {
    setup(null, { isLoading: true })
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  test('shows empty state when no favorites', () => {
    setup({ files: [], folders: [] })
    expect(screen.getByText(/no favorites yet/i)).toBeInTheDocument()
  })

  test('renders folder names', () => {
    setup()
    expect(screen.getByText('Photos')).toBeInTheDocument()
    expect(screen.getByText('Documents')).toBeInTheDocument()
  })

  test('renders file names', () => {
    setup()
    expect(screen.getByText('report.pdf')).toBeInTheDocument()
    expect(screen.getByText('image.png')).toBeInTheDocument()
  })

  test('renders file size for large file', () => {
    setup()
    expect(screen.getByText('2.0 GB')).toBeInTheDocument()
  })

  test('renders Folders and Files section headings', () => {
    setup()
    expect(screen.getByText(/folders/i)).toBeInTheDocument()
    expect(screen.getByText(/files/i)).toBeInTheDocument()
  })

  test('each item has a remove-from-favorites button', () => {
    setup()
    expect(screen.getAllByTitle(/remove from favorites/i)).toHaveLength(4)
  })

  test('shows only files section when no folders', () => {
    setup({ files: FILES, folders: [] })
    expect(screen.getByText('report.pdf')).toBeInTheDocument()
    expect(screen.queryByText('Photos')).not.toBeInTheDocument()
  })

  test('shows only folders section when no files', () => {
    setup({ files: [], folders: FOLDERS })
    expect(screen.getByText('Photos')).toBeInTheDocument()
    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument()
  })

  test('in read-only mode heading shows impersonated username', () => {
    mockImpersonatedUser = { username: 'bob', email: 'bob@example.com' }
    setup()
    expect(screen.getByRole('heading', { name: /bob's favorites/i })).toBeInTheDocument()
  })

  test('in read-only mode remove-from-favorites buttons are hidden', () => {
    mockImpersonatedUser = { username: 'bob', email: 'bob@example.com' }
    setup()
    expect(screen.queryByTitle(/remove from favorites/i)).not.toBeInTheDocument()
  })

  test('in read-only mode shows empty state message for other user', () => {
    mockImpersonatedUser = { username: 'bob', email: 'bob@example.com' }
    setup({ files: [], folders: [] })
    expect(screen.getByText(/this user has no favorites/i)).toBeInTheDocument()
  })
})
