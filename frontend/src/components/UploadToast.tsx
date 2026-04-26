import { useEffect } from 'react'
import { MdClose } from 'react-icons/md'
import type { UploadProgress, UploadStatus } from '../hooks/useFileUpload'

const AUTO_DISMISS_MS = 4000

interface StatusConfig {
  label: string
  bar: string
  accent: string
}

const STATUS_CONFIG: Record<Exclude<UploadStatus, 'idle'>, StatusConfig> = {
  uploading: { label: 'Uploading',       bar: 'bg-blue-500',   accent: 'border-blue-500'   },
  complete:  { label: 'Complete',        bar: 'bg-green-500',  accent: 'border-green-500'  },
  partial:   { label: 'Partial failure', bar: 'bg-orange-400', accent: 'border-orange-400' },
  allFailed: { label: 'Failed',          bar: 'bg-red-500',    accent: 'border-red-500'    },
}

const LABEL_COLOR: Record<Exclude<UploadStatus, 'idle'>, string> = {
  uploading: 'text-blue-600',
  complete:  'text-green-600',
  partial:   'text-orange-500',
  allFailed: 'text-red-500',
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

  return (
    <div className={`fixed bottom-6 right-6 w-80 bg-white rounded-lg border-l-4 ${config.accent} border border-gray-200 shadow-lg z-50 overflow-hidden`}>
      <div className="px-4 py-3 flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className={`text-xs font-semibold mb-0.5 ${LABEL_COLOR[status]}`}>
            {config.label}
          </div>
          <div className="text-sm text-gray-600">
            {statusMessage(progress)}
          </div>
        </div>
        {status !== 'uploading' && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className="text-gray-400 hover:text-gray-600 cursor-pointer shrink-0 mt-0.5"
          >
            <MdClose className="text-base" />
          </button>
        )}
      </div>
      <div className="h-1 bg-gray-100">
        <div
          className={`h-full ${config.bar} transition-all duration-300`}
          style={{ width: status === 'uploading' ? `${progressPct}%` : '100%' }}
        />
      </div>
    </div>
  )
}
