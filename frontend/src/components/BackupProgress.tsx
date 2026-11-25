import { MdClose, MdPause, MdPlayArrow } from 'react-icons/md'

// Progress furniture shared by the four surfaces a backup can run on: the
// Google and email picker modals (foreground) and their two toolbar cards
// (background). Keeping bar, detail line, and controls here means a running
// backup reads identically wherever the user happens to be looking.

export function formatBackupBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function formatBackupSpeed(bps: number): string {
  if (bps <= 0) return ''
  if (bps >= 1024 ** 2) return `${(bps / 1024 ** 2).toFixed(1)} MB/s`
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`
  return `${Math.round(bps)} B/s`
}

// Same "how long until remaining/rate is done" shape as UploadToast's
// fmtEta — kept as its own copy (mirroring formatBackupBytes vs UploadToast's
// fmtBytes) so this module doesn't reach into the upload/delete toast's file.
function formatBackupEta(remaining: number, ratePerSec: number): string {
  if (ratePerSec <= 0 || remaining <= 0) return ''
  const secs = remaining / ratePerSec
  if (secs > 3600) return `~${Math.ceil(secs / 3600)}h`
  if (secs > 60) return `~${Math.ceil(secs / 60)}m`
  if (secs > 5) return `~${Math.ceil(secs)}s`
  return ''
}

export function BackupProgressBar({ done, total, paused, tone = 'running' }: {
  done: number
  total: number
  paused?: boolean
  tone?: 'running' | 'ok' | 'warn'
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const color = tone === 'warn' ? 'bg-amber-500'
    : tone === 'ok' ? 'bg-green-500'
    : paused ? 'bg-amber-400'
    : 'bg-blue-500'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 shrink-0">{done} / {total}</span>
    </div>
  )
}

// The muted line under the bar: where the item currently in flight is being
// written, and how much data the run covers in total.
export function BackupProgressDetails({
  currentPath, storedBytes, totalBytes, paused, speedBps,
  itemStage, itemLoadedBytes, itemTotalBytes,
}: {
  currentPath: string | null
  storedBytes: number
  totalBytes: number
  paused?: boolean
  // Bytes/sec estimate for the whole run — omitted (or 0) until enough
  // samples exist, same as the upload/delete toasts.
  speedBps?: number
  // The item currently in flight's transfer stage, when known — the Google
  // backup flow reports this for a large file's download/upload so the line
  // moves incrementally instead of sitting on the same file name for minutes.
  itemStage?: 'downloading' | 'uploading'
  itemLoadedBytes?: number
  itemTotalBytes?: number
}) {
  const remaining = Math.max(0, totalBytes - storedBytes)
  const speed = !paused ? formatBackupSpeed(speedBps ?? 0) : ''
  const eta = !paused ? formatBackupEta(remaining, speedBps ?? 0) : ''
  const stageLabel = itemStage === 'downloading' ? 'Downloading' : itemStage === 'uploading' ? 'Uploading' : null

  return (
    <div className="min-w-0 text-[11px] text-gray-400 leading-snug">
      {currentPath && (
        <p className="m-0 truncate" title={currentPath}>
          <span>{paused ? 'Paused at' : stageLabel ?? 'Backing up'}</span>{' '}
          <span className="font-mono">{currentPath}</span>
          {!paused && stageLabel && itemTotalBytes ? (
            <span> — {formatBackupBytes(itemLoadedBytes ?? 0)} / {formatBackupBytes(itemTotalBytes)}</span>
          ) : null}
        </p>
      )}
      <p className="m-0">
        {formatBackupBytes(storedBytes)}
        {totalBytes > 0 && <> of {formatBackupBytes(totalBytes)}</>} transferred
        {(speed || eta) && <> · {[speed, eta].filter(Boolean).join(' · ')}</>}
      </p>
    </div>
  )
}

// Pause/resume + cancel, shown while a run is in flight.
export function BackupRunControls({ paused, busy, onTogglePause, onCancel, compact }: {
  paused: boolean
  busy?: boolean
  onTogglePause: () => void
  onCancel: () => void
  compact?: boolean
}) {
  const base = compact
    ? 'inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded-md cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-default border'
    : 'inline-flex items-center justify-center gap-1.5 flex-1 px-3 py-2 text-sm font-semibold rounded-lg cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-default border'
  return (
    <div className={compact ? 'flex items-center gap-1.5' : 'flex items-center gap-2'}>
      <button
        type="button"
        onClick={onTogglePause}
        disabled={busy}
        className={`${base} border-gray-200 text-gray-600 hover:bg-gray-50`}
      >
        {paused
          ? <><MdPlayArrow className={compact ? 'text-sm' : 'text-base'} /> Resume</>
          : <><MdPause className={compact ? 'text-sm' : 'text-base'} /> Pause</>}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className={`${base} border-red-200 text-red-500 hover:bg-red-50`}
      >
        <MdClose className={compact ? 'text-sm' : 'text-base'} /> Cancel
      </button>
    </div>
  )
}
