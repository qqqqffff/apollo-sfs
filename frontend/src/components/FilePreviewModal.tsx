import { useEffect, useState } from 'react'
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
    return (
      <div style={{ padding: 40, color: '#888', fontSize: 14 }}>
        Converting document…
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div style={{ padding: '40px 60px', textAlign: 'center', color: '#555' }}>
        <p style={{ marginBottom: 12 }}>Could not render this document.</p>
        <a href={downloadUrl(file.id)}>Download instead</a>
      </div>
    )
  }

  return (
    <div
      style={{
        width: '80vw',
        maxWidth: 820,
        maxHeight: '80vh',
        overflow: 'auto',
        padding: '32px 48px',
        fontSize: 15,
        lineHeight: 1.6,
        color: '#1a1a1a',
      }}
      // mammoth output is basic structural HTML with no scripts
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

  // Text and DOCX need a wider/taller body that scrolls internally; other types
  // are centered in a flex container.
  const bodyIsScrollable = kind === 'text' || kind === 'docx' || kind === 'pdf'

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 8,
          display: 'flex',
          flexDirection: 'column',
          maxWidth: '92vw',
          maxHeight: '92vh',
          overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
      >
        {/* header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            borderBottom: '1px solid #ddd',
            gap: 16,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {file.name}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <a href={downloadUrl(file.id)} style={{ fontSize: 13 }}>
              Download
            </a>
            <button
              onClick={onClose}
              aria-label="Close preview"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 20,
                lineHeight: 1,
                padding: '0 2px',
                color: '#555',
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* body */}
        <div
          style={{
            overflow: bodyIsScrollable ? 'hidden' : 'auto',
            display: 'flex',
            alignItems: bodyIsScrollable ? 'stretch' : 'center',
            justifyContent: 'center',
            flex: 1,
          }}
        >
          {kind === 'image' && (
            <img
              src={url}
              alt={file.name}
              style={{ maxWidth: '88vw', maxHeight: '80vh', objectFit: 'contain', display: 'block' }}
            />
          )}

          {kind === 'pdf' && (
            <iframe
              src={url}
              title={file.name}
              style={{ width: '88vw', height: '82vh', border: 'none', display: 'block' }}
            />
          )}

          {kind === 'video' && (
            <video
              src={streamUrl(file.id)}
              controls
              preload="metadata"
              style={{ maxWidth: '88vw', maxHeight: '80vh', display: 'block' }}
            />
          )}

          {kind === 'text' && (
            // sandbox blocks script execution; allow-same-origin lets the
            // auth cookie pass through so the API can serve the file.
            <iframe
              src={url}
              title={file.name}
              sandbox="allow-same-origin"
              style={{ width: '88vw', height: '82vh', border: 'none', display: 'block' }}
            />
          )}

          {kind === 'docx' && <DocxViewer file={file} />}

          {kind === 'unsupported' && (
            <div style={{ padding: '40px 60px', textAlign: 'center', color: '#555' }}>
              <p style={{ marginBottom: 12 }}>Preview not available for this file type.</p>
              <a href={downloadUrl(file.id)}>Download instead</a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
