import { useEffect, useState } from 'react'
import { MdClose, MdDownload } from 'react-icons/md'
import type { File } from '../types/api'
import { previewUrl, streamUrl, downloadUrl } from '../api/files'

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

function DocxViewer({ file }: { file: File }) {
  const [state, setState] = useState<DocxState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(previewUrl(file.id), { credentials: 'include' })
        if (!res.ok) throw new Error('fetch failed')
        const buf = await res.arrayBuffer()
        const mammoth = await import('mammoth')
        const result = await mammoth.convertToHtml({ arrayBuffer: buf })
        if (!cancelled) setState({ status: 'ready', html: result.value })
      } catch {
        if (!cancelled) setState({ status: 'error' })
      }
    }
    load()
    return () => { cancelled = true }
  }, [file.id])

  if (state.status === 'loading') {
    return <div className="p-10 text-sm text-gray-400">Converting document…</div>
  }

  if (state.status === 'error') {
    return (
      <div className="p-10 text-center text-gray-500 text-sm">
        <p className="mb-3">Could not render this document.</p>
        <a href={downloadUrl(file.id)} className="text-blue-600 hover:underline">Download instead</a>
      </div>
    )
  }

  return (
    <div
      className="w-[80vw] max-w-3xl max-h-[80vh] overflow-auto px-12 py-8 text-sm leading-relaxed text-gray-900 prose"
      dangerouslySetInnerHTML={{ __html: state.html }}
    />
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export function FilePreviewModal({ file, onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const kind = previewKind(file.mime_type)
  const url = previewUrl(file.id)
  const bodyIsScrollable = kind === 'text' || kind === 'docx' || kind === 'pdf'

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/75 flex items-center justify-center z-50"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl flex flex-col max-w-[92vw] max-h-[92vh] overflow-hidden shadow-2xl"
      >
        {/* header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 gap-4 min-w-0">
          <span className="font-medium text-gray-900 text-sm truncate min-w-0">{file.name}</span>
          <div className="flex items-center gap-3 shrink-0">
            <a
              href={downloadUrl(file.id)}
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
          className={`flex-1 flex items-center justify-center ${bodyIsScrollable ? 'overflow-hidden items-stretch' : 'overflow-auto'}`}
        >
          {kind === 'image' && (
            <img
              src={url}
              alt={file.name}
              className="max-w-[88vw] max-h-[80vh] object-contain block"
            />
          )}

          {kind === 'pdf' && (
            <iframe
              src={url}
              title={file.name}
              className="w-[88vw] h-[82vh] border-0 block"
            />
          )}

          {kind === 'video' && (
            <video
              src={streamUrl(file.id)}
              controls
              preload="metadata"
              className="max-w-[88vw] max-h-[80vh] block"
            />
          )}

          {kind === 'text' && (
            <iframe
              src={url}
              title={file.name}
              sandbox="allow-same-origin"
              className="w-[88vw] h-[82vh] border-0 block"
            />
          )}

          {kind === 'docx' && <DocxViewer file={file} />}

          {kind === 'unsupported' && (
            <div className="p-16 text-center text-gray-500 text-sm">
              <p className="mb-3">Preview not available for this file type.</p>
              <a href={downloadUrl(file.id)} className="text-blue-600 hover:underline">Download instead</a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
