import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { FilePreviewModal, canPreview } from '../../components/FilePreviewModal'
import type { File as ApiFile } from '../../types/api'

jest.mock('../../api/files', () => ({
  presignFile: jest.fn().mockResolvedValue({
    download_url: '/api/v1/files/f1/download/p?token=test-tok',
    preview_url:  '/api/v1/files/f1/preview/p?token=test-tok',
    expires_at:   '2099-01-01T00:00:00Z',
  }),
  streamUrl: (id: string, q?: string) => `/stream/${id}${q ? `?q=${q}` : ''}`,
}))

// mammoth and dompurify are only imported inside DocxViewer; mock them lazily.
jest.mock('mammoth', () => ({
  convertToHtml: jest.fn().mockResolvedValue({ value: '<p>doc content</p>' }),
}))
jest.mock('dompurify', () => ({
  default: { sanitize: (s: string) => s },
}))

function makeFile(overrides: Partial<ApiFile> = {}): ApiFile {
  return {
    id: 'f1',
    name: 'test-file.jpg',
    size_bytes: 1024,
    mime_type: 'image/jpeg',
    created_at: '2024-01-01T00:00:00Z',
    folder_id: null,
    has_low_variant: false,
    ...overrides,
  } as ApiFile
}

describe('canPreview', () => {
  test.each([
    ['image/jpeg', true],
    ['image/png', true],
    ['application/pdf', true],
    ['video/mp4', true],
    ['text/plain', true],
    ['application/json', true],
    ['application/xml', true],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', true],
    ['application/zip', false],
    ['application/octet-stream', false],
  ])('%s → %s', (mime, expected) => {
    expect(canPreview(mime)).toBe(expected)
  })
})

describe('FilePreviewModal', () => {
  const onClose = jest.fn()

  beforeEach(() => onClose.mockReset())

  test('renders the file name in the header', () => {
    render(<FilePreviewModal file={makeFile({ name: 'photo.jpg' })} onClose={onClose} />)
    expect(screen.getByText('photo.jpg')).toBeInTheDocument()
  })

  test('close button calls onClose', () => {
    render(<FilePreviewModal file={makeFile()} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close preview/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('backdrop click calls onClose', () => {
    const { container } = render(<FilePreviewModal file={makeFile()} onClose={onClose} />)
    const backdrop = container.querySelector('.fixed.inset-0') as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('Escape key calls onClose', () => {
    render(<FilePreviewModal file={makeFile()} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('download link uses presigned URL after mount', async () => {
    render(<FilePreviewModal file={makeFile({ id: 'abc' })} onClose={onClose} />)
    const link = await waitFor(() => {
      const a = screen.getByRole('link', { name: /download/i })
      expect(a).toHaveAttribute('href')
      return a
    })
    expect(link.getAttribute('href')).toContain('/download/p?token=')
  })

  // ── per-type rendering ───────────────────────────────────────────────────────

  test('renders <img> for image files with presigned src', async () => {
    const { container } = render(
      <FilePreviewModal file={makeFile({ id: 'img1', mime_type: 'image/jpeg' })} onClose={onClose} />,
    )
    const img = await waitFor(() => {
      const el = container.querySelector('img')
      expect(el).toBeInTheDocument()
      expect(el?.src).toContain('/preview/p?token=')
      return el
    })
    expect(img).toBeTruthy()
  })

  test('renders <iframe> for PDF files with presigned src', async () => {
    const { container } = render(
      <FilePreviewModal file={makeFile({ id: 'pdf1', mime_type: 'application/pdf' })} onClose={onClose} />,
    )
    await waitFor(() => {
      const iframe = container.querySelector('iframe')
      expect(iframe).toBeInTheDocument()
      expect(iframe?.src).toContain('/preview/p?token=')
    })
  })

  test('renders <video> for video files using streamUrl (not presigned)', () => {
    const { container } = render(
      <FilePreviewModal file={makeFile({ id: 'vid1', mime_type: 'video/mp4' })} onClose={onClose} />,
    )
    const video = container.querySelector('video')
    expect(video).toBeInTheDocument()
    expect(video?.src).toContain('/stream/vid1')
  })

  test('renders <iframe> for text files with presigned src', async () => {
    const { container } = render(
      <FilePreviewModal file={makeFile({ mime_type: 'text/plain' })} onClose={onClose} />,
    )
    await waitFor(() => {
      expect(container.querySelector('iframe')).toBeInTheDocument()
    })
  })

  test('renders unsupported message for unknown types', () => {
    render(
      <FilePreviewModal file={makeFile({ mime_type: 'application/zip' })} onClose={onClose} />,
    )
    expect(screen.getByText(/preview not available/i)).toBeInTheDocument()
  })

  test('unsupported type shows a download link once presign resolves', async () => {
    render(
      <FilePreviewModal file={makeFile({ id: 'zip1', mime_type: 'application/zip' })} onClose={onClose} />,
    )
    await waitFor(() => {
      const links = screen.getAllByRole('link', { name: /download/i })
      expect(links.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ── video quality toggle ───────────────────────────────────────────────────

  test('quality toggle not shown when video has no low variant', () => {
    render(
      <FilePreviewModal
        file={makeFile({ mime_type: 'video/mp4', has_low_variant: false })}
        onClose={onClose}
      />,
    )
    expect(screen.queryByTitle(/switch to/i)).not.toBeInTheDocument()
  })

  test('quality toggle shows when video has a low variant', () => {
    render(
      <FilePreviewModal
        file={makeFile({ mime_type: 'video/mp4', has_low_variant: true })}
        onClose={onClose}
      />,
    )
    expect(screen.getByTitle(/switch to/i)).toBeInTheDocument()
  })

  test('quality toggle button label changes on click', () => {
    render(
      <FilePreviewModal
        file={makeFile({ mime_type: 'video/mp4', has_low_variant: true })}
        onClose={onClose}
      />,
    )
    const btn = screen.getByTitle(/switch to 480p/i)
    expect(btn).toHaveTextContent('Original')
    fireEvent.click(btn)
    expect(screen.getByTitle(/switch to original/i)).toHaveTextContent('480p')
  })
})
