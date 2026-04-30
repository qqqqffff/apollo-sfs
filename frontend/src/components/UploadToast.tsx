import { useEffect } from 'react'
import { MdClose } from 'react-icons/md'
import type { UploadProgress, UploadStatus, FileUploadItem } from '../hooks/useFileUpload'

const AUTO_DISMISS_MS = 5000

// ── Formatters ─────────────────────────────────────────────────────────────────

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024)      return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function fmtSpeed(bps: number): string {
  if (bps <= 0) return ''
  if (bps >= 1024 ** 2) return `${(bps / 1024 ** 2).toFixed(1)} MB/s`
  if (bps >= 1024)      return `${(bps / 1024).toFixed(0)} KB/s`
  return `${Math.round(bps)} B/s`
}

function fmtEta(remainingBytes: number, speedBps: number): string {
  if (speedBps < 512 || remainingBytes <= 0) return ''
  const secs = remainingBytes / speedBps
  if (secs > 3600) return `~${Math.ceil(secs / 3600)}h`
  if (secs > 60)   return `~${Math.ceil(secs / 60)}m`
  if (secs > 5)    return `~${Math.ceil(secs)}s`
  return ''
}

// ── Status config ──────────────────────────────────────────────────────────────

interface StatusConfig { label: string; bar: string; accent: string; labelColor: string }

const STATUS_CONFIG: Record<Exclude<UploadStatus, 'idle'>, StatusConfig> = {
  uploading: { label: 'Uploading',       bar: 'bg-blue-500',   accent: 'border-blue-500',   labelColor: 'text-blue-600'  },
  complete:  { label: 'Complete',        bar: 'bg-green-500',  accent: 'border-green-500',  labelColor: 'text-green-600' },
  partial:   { label: 'Partial failure', bar: 'bg-orange-400', accent: 'border-orange-400', labelColor: 'text-orange-500'},
  allFailed: { label: 'Failed',          bar: 'bg-red-500',    accent: 'border-red-500',    labelColor: 'text-red-500'   },
}

// ── Per-file row ───────────────────────────────────────────────────────────────

function FileRow({ item }: { item: FileUploadItem }) {
  const pct = item.size > 0 ? Math.min((item.loaded / item.size) * 100, 100) : 0
  const barColor =
    item.status === 'done'     ? 'bg-green-500' :
    item.status === 'failed'   ? 'bg-red-400'   :
    item.status === 'queued'   ? 'bg-gray-200'  : 'bg-blue-500'

  const rightLabel =
    item.status === 'done'   ? <span className="text-green-600">done</span> :
    item.status === 'failed' ? <span className="text-red-500">failed</span> :
    item.status === 'queued' ? <span className="text-gray-400">queued</span> :
                               <span className="text-gray-500">{Math.round(pct)}%</span>

  return (
    <div className="flex items-center gap-2 py-1 min-w-0">
      <span className="flex-1 truncate text-xs text-gray-700 min-w-0">{item.name}</span>
      <div className="w-20 h-1 bg-gray-100 rounded-full overflow-hidden shrink-0">
        <div
          className={`h-full rounded-full transition-all duration-150 ${barColor}`}
          style={{ width: item.status === 'done' ? '100%' : `${pct}%` }}
        />
      </div>
      <span className="text-xs w-10 text-right shrink-0">{rightLabel}</span>
    </div>
  )
}

// ── Toast ──────────────────────────────────────────────────────────────────────

interface Props {
  progress: UploadProgress
  onDismiss: () => void
}

export function UploadToast({ progress, onDismiss }: Props) {
  const { status, items, totalBytes, loadedBytes, speedBps, succeeded, failed } = progress

  useEffect(() => {
    if (status !== 'complete') return
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(t)
  }, [status, onDismiss])

  if (status === 'idle') return null

  const config = STATUS_CONFIG[status]
  const bytesPct = totalBytes > 0 ? Math.min((loadedBytes / totalBytes) * 100, 100) : 0
  const remainingBytes = Math.max(0, totalBytes - loadedBytes)
  const speed = fmtSpeed(speedBps)
  const eta   = fmtEta(remainingBytes, speedBps)
  const isUploading = status === 'uploading'

  return (
    <div className={`fixed bottom-6 right-6 w-88 bg-white rounded-lg border-l-4 ${config.accent} border border-gray-200 shadow-xl z-50 overflow-hidden`}
      style={{ width: '22rem' }}
    >
      {/* Header */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-xs font-semibold shrink-0 ${config.labelColor}`}>
            {config.label}
          </span>
          {isUploading && (speed || eta) && (
            <span className="text-xs text-gray-400 truncate">
              {[speed, eta].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
        {!isUploading && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className="text-gray-400 hover:text-gray-600 cursor-pointer shrink-0"
          >
            <MdClose className="text-base" />
          </button>
        )}
      </div>

      {/* Byte-level summary */}
      <div className="px-4 pb-2 flex items-center justify-between text-xs text-gray-500 gap-2">
        {isUploading ? (
          <>
            <span>{fmtBytes(loadedBytes)} / {fmtBytes(totalBytes)}</span>
            <span className="text-gray-400">{bytesPct.toFixed(0)}%</span>
          </>
        ) : status === 'complete' ? (
          <span>{items.length} file{items.length !== 1 ? 's' : ''} · {fmtBytes(totalBytes)}</span>
        ) : (
          <span>{succeeded} uploaded · {failed} failed</span>
        )}
      </div>

      {/* Overall progress bar */}
      <div className="px-4 pb-2">
        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-150 ${config.bar}`}
            style={{ width: isUploading ? `${bytesPct}%` : '100%' }}
          />
        </div>
      </div>

      {/* Per-file rows (scrollable if many files) */}
      {items.length > 1 && (
        <div className="px-4 pb-3 max-h-36 overflow-y-auto border-t border-gray-100 pt-2">
          {items.map((item, i) => (
            <FileRow key={i} item={item} />
          ))}
        </div>
      )}

      {/* Single-file name when only one file */}
      {items.length === 1 && (
        <div className="px-4 pb-3 border-t border-gray-100 pt-2">
          <FileRow item={items[0]} />
        </div>
      )}
    </div>
  )
}
