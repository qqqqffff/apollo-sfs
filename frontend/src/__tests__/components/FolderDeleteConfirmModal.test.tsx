import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FolderDeleteConfirmModal } from '../../components/FolderDeleteConfirmModal'
import { clearSkipDeleteCookie, readSkipDeleteCookie } from '../../components/DeleteConfirmModal'

const enumerateFolderContents = jest.fn()

jest.mock('../../hooks/useDeleteJob', () => ({
  enumerateFolderContents: (...a: unknown[]) => enumerateFolderContents(...a),
}))

const defaults = {
  folder: { id: 'folder-1', name: 'user@example.com', sizeBytes: 3 * 1024 * 1024 },
  username: 'alice',
  usedBytes: 10 * 1024 * 1024,
  quotaBytes: 100 * 1024 * 1024,
  onConfirm: jest.fn(),
  onCancel: jest.fn(),
}

function renderModal(props: Partial<React.ComponentProps<typeof FolderDeleteConfirmModal>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <FolderDeleteConfirmModal {...defaults} {...props} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  clearSkipDeleteCookie()
  enumerateFolderContents.mockResolvedValue({
    files: [
      { id: 'f1', name: 'one.email.json', size_bytes: 1024 * 1024 },
      { id: 'f2', name: 'two.email.json', size_bytes: 2 * 1024 * 1024 },
    ],
    folderIdsPostOrder: ['folder-1'],
  })
})

describe('FolderDeleteConfirmModal', () => {
  test('shows a loading state while the preview loads', () => {
    enumerateFolderContents.mockReturnValue(new Promise(() => {}))
    renderModal()
    expect(screen.getByText('Loading contents…')).toBeInTheDocument()
  })

  test('lists every file about to be deleted once loaded', async () => {
    renderModal()
    expect(await screen.findByText('one.email.json')).toBeInTheDocument()
    expect(screen.getByText('two.email.json')).toBeInTheDocument()
    expect(screen.getByText('2 files')).toBeInTheDocument()
  })

  test('shows the quota impact preview', async () => {
    renderModal()
    await screen.findByText('one.email.json')

    // usedBytes=10MB, folder=3MB → after=7MB used, 3MB freed.
    expect(screen.getByText('After deletion: 7.0 MB used')).toBeInTheDocument()
    expect(screen.getByText('3.0 MB freed')).toBeInTheDocument()
  })

  test('mentions subfolders in the warning when the subtree has any', async () => {
    enumerateFolderContents.mockResolvedValue({
      files: [{ id: 'f1', name: 'one.email.json', size_bytes: 10 }],
      folderIdsPostOrder: ['child-1', 'folder-1'],
    })
    renderModal()
    expect(await screen.findByText(/including 1 subfolder/)).toBeInTheDocument()
  })

  test('caps the rendered rows and notes how many more are included in the total', async () => {
    const many = Array.from({ length: 205 }, (_, i) => ({ id: `f${i}`, name: `msg-${i}.json`, size_bytes: 10 }))
    enumerateFolderContents.mockResolvedValue({ files: many, folderIdsPostOrder: ['folder-1'] })
    renderModal()
    await screen.findByText('msg-0.json')
    expect(screen.getByText('+ 5 more files (included in the total below).')).toBeInTheDocument()
  })

  test('says the folder is empty when there are no files', async () => {
    enumerateFolderContents.mockResolvedValue({ files: [], folderIdsPostOrder: ['folder-1'] })
    renderModal()
    expect(await screen.findByText('This folder is empty.')).toBeInTheDocument()
  })

  test('Cancel calls onCancel without confirming', async () => {
    renderModal()
    await screen.findByText('one.email.json')
    fireEvent.click(screen.getByText('Cancel'))
    expect(defaults.onCancel).toHaveBeenCalledTimes(1)
    expect(defaults.onConfirm).not.toHaveBeenCalled()
  })

  test('Delete calls onConfirm', async () => {
    renderModal()
    await screen.findByText('one.email.json')
    fireEvent.click(screen.getByText('Delete'))
    expect(defaults.onConfirm).toHaveBeenCalledTimes(1)
  })

  test('confirming with "don\'t show again" checked sets the skip cookie', async () => {
    renderModal()
    await screen.findByText('one.email.json')
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByText('Delete'))
    expect(readSkipDeleteCookie('alice')).toBe(true)
  })

  test('shows an error state if the preview fails to load', async () => {
    enumerateFolderContents.mockRejectedValue(new Error('network error'))
    renderModal()
    await waitFor(() => {
      expect(screen.getByText("Could not load this folder's contents.")).toBeInTheDocument()
    })
  })
})
