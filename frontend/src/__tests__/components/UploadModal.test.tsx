import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { UploadModal } from '../../components/UploadModal'
import type { User } from '../../types/api'

const GB = 1024 ** 3

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    username: 'alice',
    email: 'alice@example.com',
    is_admin: false,
    storage_used_bytes: 1 * GB,
    storage_quota_bytes: 10 * GB,
    created_at: '2024-01-01T00:00:00Z',
    last_seen_at: null,
    ...overrides,
  } as User
}

function makeFile(name: string, size: number): globalThis.File {
  return { name, size } as globalThis.File
}

const defaultFiles = [
  makeFile('photo.jpg', 1024 * 1024),       // 1 MB
  makeFile('document.pdf', 512 * 1024),      // 512 KB
]

describe('UploadModal', () => {
  const onConfirm = jest.fn()
  const onCancel = jest.fn()

  beforeEach(() => {
    onConfirm.mockReset()
    onCancel.mockReset()
  })

  function renderModal(files = defaultFiles, user = makeUser()) {
    return render(
      <UploadModal
        files={files}
        folderName="My Folder"
        user={user}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
  }

  test('renders Upload files heading', () => {
    renderModal()
    expect(screen.getByRole('heading', { name: /upload files/i })).toBeInTheDocument()
  })

  test('shows the target folder name', () => {
    renderModal()
    expect(screen.getByText('My Folder')).toBeInTheDocument()
  })

  test('lists every file name', () => {
    renderModal()
    expect(screen.getByText('photo.jpg')).toBeInTheDocument()
    expect(screen.getByText('document.pdf')).toBeInTheDocument()
  })

  test('shows formatted sizes in the table', () => {
    renderModal()
    expect(screen.getByText('1.0 MB')).toBeInTheDocument()
    expect(screen.getByText('512.0 KB')).toBeInTheDocument()
  })

  test('shows the file count in the footer', () => {
    renderModal()
    // Use exact string so it matches only the <td> and not the "Upload 2 files" button
    expect(screen.getByText('2 files')).toBeInTheDocument()
  })

  test('shows singular "file" when one file', () => {
    renderModal([makeFile('solo.txt', 100)])
    expect(screen.getByText('1 file')).toBeInTheDocument()
  })

  test('upload button label reflects file count', () => {
    renderModal()
    expect(screen.getByRole('button', { name: /upload 2 files/i })).toBeInTheDocument()
  })

  test('upload button label is singular for one file', () => {
    renderModal([makeFile('solo.txt', 100)])
    expect(screen.getByRole('button', { name: /upload file/i })).toBeInTheDocument()
  })

  test('Cancel button fires onCancel', () => {
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test('Upload button fires onConfirm', () => {
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /upload 2 files/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  test('backdrop click fires onCancel', () => {
    const { container } = renderModal()
    const backdrop = container.querySelector('.fixed.inset-0') as HTMLElement
    fireEvent.click(backdrop)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test('Escape key fires onCancel', () => {
    renderModal()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test('shows remaining storage after upload when within quota', () => {
    renderModal()
    expect(screen.getByText(/remaining/i)).toBeInTheDocument()
  })

  test('upload button is disabled when upload exceeds quota', () => {
    const user = makeUser({ storage_used_bytes: 9.5 * GB, storage_quota_bytes: 10 * GB })
    const bigFile = makeFile('huge.bin', 1 * GB)
    renderModal([bigFile], user)
    expect(screen.getByRole('button', { name: /upload file/i })).toBeDisabled()
  })

  test('shows "Exceeds quota" message when over limit', () => {
    const user = makeUser({ storage_used_bytes: 9.5 * GB, storage_quota_bytes: 10 * GB })
    const bigFile = makeFile('huge.bin', 1 * GB)
    renderModal([bigFile], user)
    expect(screen.getByText(/exceeds quota/i)).toBeInTheDocument()
  })

  test('upload button is enabled within quota', () => {
    renderModal()
    expect(screen.getByRole('button', { name: /upload 2 files/i })).not.toBeDisabled()
  })
})
