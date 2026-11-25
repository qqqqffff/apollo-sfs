import { useEffect } from 'react'
import { MdClose } from 'react-icons/md'
import type { UploadProgress, UploadStatus, FileUploadItem } from '../hooks/useFileUpload'
import { BackupRunControls } from './BackupProgress'

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

function fmtRate(perSec: number): string {
  if (perSec <= 0) return ''
  return `~${perSec >= 10 ? Math.round(perSec) : perSec.toFixed(1)}/s`
}

// Generic "how long until remaining/rate is done" — used both for bytes/sec
// (uploads) and objects/sec (deletes, where request cost is roughly
// independent of file size, so an object-count rate estimates better).
function fmtEta(remaining: number, ratePerSec: number): string {
  if (ratePerSec <= 0 || remaining <= 0) return ''
  const secs = remaining / ratePerSec
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
  cancelled: { label: 'Cancelled',       bar: 'bg-amber-400',  accent: 'border-amber-400',  labelColor: 'text-amber-600' },
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
    <div className="py-1 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="flex-1 truncate text-xs text-gray-700 min-w-0" title={item.name}>{item.name}</span>
        <div className="w-20 h-1 bg-gray-100 rounded-full overflow-hidden shrink-0">
          <div
            className={`h-full rounded-full transition-all duration-150 ${barColor}`}
            style={{ width: item.status === 'done' ? '100%' : `${pct}%` }}
          />
        </div>
        <span className="text-xs w-10 text-right shrink-0">{rightLabel}</span>
      </div>
      {item.status === 'failed' && item.error && (
        <p className="text-[10px] text-red-500 truncate mt-0.5" title={item.error}>{item.error}</p>
      )}
    </div>
  )
}

// ── Toast ──────────────────────────────────────────────────────────────────────

interface Props {
  progress: UploadProgress
  onDismiss: () => void
  // Label used for the in-progress header (e.g. "Uploading", "Moving").
  // Defaults to "Uploading" so the existing upload flow is unaffected.
  verb?: string
  // Re-attempts only the items still in 'failed' status. Omitted for progress
  // sources that don't support retry (e.g. drive migration).
  onRetry?: () => void
  // 'items' swaps the aggregate summary/progress bar from a byte count to an
  // object count ("3 / 12 objects deleted") — used by the delete toast, where
  // how many objects are gone matters more than how many bytes moved.
  // Defaults to 'bytes' so the existing upload flow is unaffected.
  unit?: 'bytes' | 'items'
  // Past-tense verb for the object-count summaries (e.g. "deleted"). Defaults
  // to "uploaded" so the existing upload flow is unaffected.
  doneWord?: string
  // True while the run is paused. Pause/cancel controls (same
  // pause/resume/cancel logic the Google/email backup flows use — see
  // api/backupControl.ts) only render while uploading and only when
  // onRequestCancel is given, so a read-only progress source (e.g. drive
  // migration's polled subscription) is unaffected.
  paused?: boolean
  onTogglePause?: () => void
  // Opens the caller's own cancel-confirmation flow (pausing first, same as
  // the backup flows' Cancel button) rather than cancelling directly, so the
  // caller can decide what a cancel actually does (e.g. offer to roll back
  // an upload, or just stop a delete in place).
  onRequestCancel?: () => void
}

export function UploadToast({
  progress, onDismiss, verb = 'Uploading', onRetry, unit = 'bytes', doneWord = 'uploaded',
  paused, onTogglePause, onRequestCancel,
}: Props) {
  const { status, items, totalBytes, loadedBytes, speedBps, succeeded, failed } = progress

  useEffect(() => {
    if (status !== 'complete') return
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(t)
  }, [status, onDismiss])

  if (status === 'idle') return null

  const config = STATUS_CONFIG[status]
  const label = status === 'uploading' ? verb : config.label
  const bytesPct = totalBytes > 0 ? Math.min((loadedBytes / totalBytes) * 100, 100) : 0
  // totalObjects/doneObjects report the true recursive count for jobs whose
  // real unit of work is finer than `items` (a folder delete); fall back to
  // items.length / done-item-count for a plain upload, where they're the same.
  const totalObjects = progress.totalObjects ?? items.length
  const doneObjects = progress.doneObjects ?? items.filter((it) => it.status === 'done').length
  const objectsPct = totalObjects > 0 ? Math.min((doneObjects / totalObjects) * 100, 100) : 0
  const overallPct = unit === 'items' ? objectsPct : bytesPct
  const remainingBytes = Math.max(0, totalBytes - loadedBytes)
  const remainingObjects = Math.max(0, totalObjects - doneObjects)
  const speed = unit === 'items' ? fmtRate(progress.objectsPerSec ?? 0) : fmtSpeed(speedBps)
  const eta   = unit === 'items'
    ? fmtEta(remainingObjects, progress.objectsPerSec ?? 0)
    : fmtEta(remainingBytes, speedBps)
  const isUploading = status === 'uploading'
  const displayLabel = isUploading && paused ? 'Paused' : label

  return (
    <div className={`fixed bottom-6 right-6 w-88 bg-white rounded-lg border-l-4 ${config.accent} border border-gray-200 shadow-xl z-50 overflow-hidden`}
      style={{ width: '22rem' }}
    >
      {/* Header */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-xs font-semibold shrink-0 ${paused ? 'text-amber-600' : config.labelColor}`}>
            {displayLabel}
          </span>
          {isUploading && !paused && (speed || eta) && (
            <span className="text-xs text-gray-400 truncate">
              {[speed, eta].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
        {isUploading ? (
          onRequestCancel && (
            <div className="shrink-0">
              <BackupRunControls
                compact
                paused={!!paused}
                onTogglePause={onTogglePause ?? (() => {})}
                onCancel={onRequestCancel}
              />
            </div>
          )
        ) : (
          <div className="flex items-center gap-2 shrink-0">
            {failed > 0 && onRetry && (
              <button
                onClick={onRetry}
                className="text-xs font-semibold text-blue-600 hover:text-blue-700 cursor-pointer"
              >
                Retry failed
              </button>
            )}
            <button
              onClick={onDismiss}
              aria-label="Dismiss"
              className="text-gray-400 hover:text-gray-600 cursor-pointer"
            >
              <MdClose className="text-base" />
            </button>
          </div>
        )}
      </div>

      {/* Byte- or object-count summary, depending on unit */}
      <div className="px-4 pb-2 flex items-center justify-between text-xs text-gray-500 gap-2">
        {isUploading ? (
          unit === 'items' ? (
            <>
              <span>{doneObjects} / {totalObjects} object{totalObjects !== 1 ? 's' : ''} {doneWord}</span>
              <span className="text-gray-400">{objectsPct.toFixed(0)}%</span>
            </>
          ) : (
            <>
              <span>{fmtBytes(loadedBytes)} / {fmtBytes(totalBytes)}</span>
              <span className="text-gray-400">{bytesPct.toFixed(0)}%</span>
            </>
          )
        ) : status === 'complete' ? (
          unit === 'items'
            ? <span>{totalObjects} object{totalObjects !== 1 ? 's' : ''} {doneWord}</span>
            : <span>{items.length} file{items.length !== 1 ? 's' : ''} · {fmtBytes(totalBytes)}</span>
        ) : status === 'cancelled' ? (
          unit === 'items'
            ? <span>{doneObjects} {doneWord} — cancelled</span>
            : <span>{succeeded} {doneWord} — cancelled</span>
        ) : (
          unit === 'items'
            ? <span>{doneObjects} {doneWord} · {remainingObjects} failed</span>
            : <span>{succeeded} {doneWord} · {failed} failed</span>
        )}
      </div>

      {/* Bytes freed sits alongside the object count for the delete toast —
          "how many" and "how much space" both matter there. */}
      {unit === 'items' && totalBytes > 0 && (
        <div className="px-4 pb-2 -mt-1.5 text-[11px] text-gray-400">
          {fmtBytes(loadedBytes)} / {fmtBytes(totalBytes)} freed
        </div>
      )}

      {/* Overall progress bar */}
      <div className="px-4 pb-2">
        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-150 ${config.bar}`}
            style={{ width: isUploading ? `${overallPct}%` : '100%' }}
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
