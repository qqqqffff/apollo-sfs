import { useEffect } from 'react'
import type { UploadProgress, UploadStatus } from '../hooks/useFileUpload'

const AUTO_DISMISS_MS = 4000

interface StatusConfig {
  label: string
  color: string
}

const STATUS_CONFIG: Record<Exclude<UploadStatus, 'idle'>, StatusConfig> = {
  uploading: { label: 'Uploading', color: '#4a90e2' },
  complete:  { label: 'Complete',  color: '#38a169' },
  partial:   { label: 'Partial failure', color: '#dd6b20' },
  allFailed: { label: 'Failed',    color: '#e53e3e' },
}

function statusMessage(progress: UploadProgress): string {
  const { status, total, succeeded, failed } = progress
  const done = succeeded + failed
  if (status === 'uploading') return `Uploading… (${done} / ${total})`
  if (status === 'complete')  return `${total} file${total !== 1 ? 's' : ''} uploaded successfully`
  if (status === 'partial')   return `${succeeded} uploaded · ${failed} failed after retries`
  return `All ${total} upload${total !== 1 ? 's' : ''} failed after retries`
}

interface Props {
  progress: UploadProgress
  onDismiss: () => void
}

export function UploadToast({ progress, onDismiss }: Props) {
  const { status, succeeded, failed } = progress

  useEffect(() => {
    if (status !== 'complete') return
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(t)
  }, [status, onDismiss])

  if (status === 'idle') return null

  const config = STATUS_CONFIG[status]
  const done = succeeded + failed
  const total = progress.total
  const progressPct = total > 0 ? (done / total) * 100 : 0
  const barColor =
    status === 'uploading' ? '#4a90e2' :
    status === 'complete'  ? '#38a169' :
    status === 'partial'   ? '#dd6b20' :
    '#e53e3e'

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        width: 320,
        background: '#fff',
        border: '1px solid #ddd',
        borderLeft: `4px solid ${config.color}`,
        borderRadius: 6,
        boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
        zIndex: 1001,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '12px 14px',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: config.color, marginBottom: 3 }}>
            {config.label}
          </div>
          <div style={{ fontSize: 13, color: '#444' }}>
            {statusMessage(progress)}
          </div>
        </div>

        {status !== 'uploading' && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#888',
              fontSize: 16,
              lineHeight: 1,
              padding: '0 2px',
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div style={{ height: 4, background: '#eee' }}>
        <div
          style={{
            height: '100%',
            width: status === 'uploading' ? `${progressPct}%` : '100%',
            background: barColor,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
    </div>
  )
}
