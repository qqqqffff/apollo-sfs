import { useEffect, useRef, useState } from 'react'
import { MdClose, MdDownload } from 'react-icons/md'
import type { File } from '../types/api'
import { presignFile, streamUrl } from '../api/files'

interface Props {
  file: File
  onClose: () => void
}

type PreviewKind = 'image' | 'pdf' | 'video' | 'text' | 'docx' | 'unsupported'

function previewKind(mimeType: string): PreviewKind {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.startsWith('video/')) return 'video'
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml'
  ) return 'text'
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    return 'docx'
  return 'unsupported'
}

export function canPreview(mimeType: string): boolean {
  return previewKind(mimeType) !== 'unsupported'
}

// ── DOCX viewer ───────────────────────────────────────────────────────────────

type DocxState =
  | { status: 'loading' }
  | { status: 'ready'; html: string }
  | { status: 'error' }

function DocxViewer({ previewUrl, downloadUrl }: { previewUrl: string; downloadUrl: string }) {
  const [state, setState] = useState<DocxState>({ status: 'loading' })

  useEffect(() => {
    if (!previewUrl) return
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(previewUrl)
        if (!res.ok) throw new Error('fetch failed')
        const buf = await res.arrayBuffer()
        const mammoth = await import('mammoth')
        const DOMPurify = (await import('dompurify')).default
        const result = await mammoth.convertToHtml({ arrayBuffer: buf })
        if (!cancelled) setState({ status: 'ready', html: DOMPurify.sanitize(result.value) })
      } catch {
        if (!cancelled) setState({ status: 'error' })
      }
    }
    load()
    return () => { cancelled = true }
  }, [previewUrl])

  if (state.status === 'loading') {
    return <div className="p-10 text-sm text-gray-400">Converting document…</div>
  }

  if (state.status === 'error') {
    return (
      <div className="p-10 text-center text-gray-500 text-sm">
        <p className="mb-3">Could not render this document.</p>
        {downloadUrl && (
          <a href={downloadUrl} className="text-blue-600 hover:underline">Download instead</a>
        )}
      </div>
    )
  }

  return (
    <div
      className="w-full overflow-auto px-6 sm:px-12 py-8 text-sm leading-relaxed text-gray-900 prose max-w-none"
      dangerouslySetInnerHTML={{ __html: state.html }}
    />
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export function FilePreviewModal({ file, onClose }: Props) {
  const kind = previewKind(file.mime_type)

  // Presigned URLs fetched on mount for non-video previews and downloads.
  const [downloadLink, setDownloadLink] = useState('')
  const [previewLink, setPreviewLink] = useState('')

  useEffect(() => {
    let cancelled = false
    presignFile(file.id).then(({ download_url, preview_url }) => {
      if (!cancelled) {
        setDownloadLink(download_url)
        setPreviewLink(preview_url)
      }
    }).catch(() => {
      // Presign failed — links stay empty; UI shows disabled state gracefully.
    })
    return () => { cancelled = true }
  }, [file.id])

  // Auto-select 480p on slow connections when a low-quality variant is ready.
  const [quality, setQuality] = useState<'original' | 'low'>(() => {
    if (kind !== 'video' || !file.has_low_variant) return 'original'
    const conn = (navigator as any).connection
    if (conn) {
      if (conn.effectiveType === '2g' || conn.effectiveType === 'slow-2g') return 'low'
      if (typeof conn.downlink === 'number' && conn.downlink < 5) return 'low'
    }
    return 'original'
  })

  // Re-load video when quality changes by remounting via key.
  const videoKey = useRef(0)
  const prevQuality = useRef(quality)
  if (prevQuality.current !== quality) {
    videoKey.current++
    prevQuality.current = quality
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const bodyIsScrollable = kind === 'text' || kind === 'docx' || kind === 'pdf'

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/75 flex items-center justify-center z-50"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl flex flex-col w-[92vw] max-w-4xl h-[92svh] overflow-hidden shadow-2xl"
      >
        {/* header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 gap-4 min-w-0 shrink-0">
          <span className="font-medium text-gray-900 text-sm truncate min-w-0">{file.name}</span>
          <div className="flex items-center gap-3 shrink-0">
            {kind === 'video' && file.has_low_variant && (
              <button
                onClick={() => setQuality(q => q === 'low' ? 'original' : 'low')}
                title={quality === 'low' ? 'Switch to original quality' : 'Switch to 480p (lower data usage)'}
                className="text-xs border border-gray-200 rounded px-2 py-1 cursor-pointer transition-colors text-gray-500 hover:text-gray-900 hover:border-gray-400"
              >
                {quality === 'low' ? '480p' : 'Original'}
              </button>
            )}
            <a
              href={downloadLink || undefined}
              aria-disabled={!downloadLink}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900 transition-colors"
            >
              <MdDownload className="text-base" /> Download
            </a>
            <button
              onClick={onClose}
              aria-label="Close preview"
              className="text-gray-400 hover:text-gray-700 cursor-pointer transition-colors"
            >
              <MdClose className="text-xl" />
            </button>
          </div>
        </div>

        {/* body */}
        <div
          className={`flex-1 min-h-0 flex ${bodyIsScrollable ? 'items-stretch' : 'items-center justify-center overflow-auto'}`}
        >
          {kind === 'image' && previewLink && (
            <img
              src={previewLink}
              alt={file.name}
              className="max-w-full max-h-full object-contain block"
            />
          )}

          {kind === 'pdf' && previewLink && (
            <iframe
              src={previewLink}
              title={file.name}
              className="w-full h-full border-0 block"
            />
          )}

          {kind === 'video' && (
            <video
              key={videoKey.current}
              src={streamUrl(file.id, quality === 'low' ? 'low' : undefined)}
              controls
              playsInline
              preload="metadata"
              className="max-w-full max-h-full block"
            />
          )}

          {kind === 'text' && previewLink && (
            <iframe
              src={previewLink}
              title={file.name}
              sandbox="allow-same-origin"
              className="w-full h-full border-0 block"
            />
          )}

          {kind === 'docx' && (
            <DocxViewer previewUrl={previewLink} downloadUrl={downloadLink} />
          )}

          {kind === 'unsupported' && (
            <div className="p-16 text-center text-gray-500 text-sm">
              <p className="mb-3">Preview not available for this file type.</p>
              {downloadLink && (
                <a href={downloadLink} className="text-blue-600 hover:underline">Download instead</a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
