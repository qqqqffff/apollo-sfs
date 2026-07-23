import { useEffect, useRef, useState } from 'react'
import { MdAddCircleOutline, MdFolder, MdLock, MdLockOpen, MdMoreVert, MdPieChart } from 'react-icons/md'
import type { User } from '../types/api'
import { TierIcon } from './TierIcon'

interface UploadLocation {
  name: string
  tier: 'nvme' | 'hdd'
  isPinned: boolean
  serverId: string
  // This drive's own used/quota bytes — the storage bar shows this tier's
  // allocation, not the account-wide total across every drive the user owns.
  usedBytes: number
  quotaBytes: number
}

interface Props {
  files: globalThis.File[]
  folderName: string
  user: User
  // The drive this upload will land on, when known — omitted while the
  // user's own drive allocations are still loading.
  location?: UploadLocation
  // Name of the user's media auto-upload folder, when the photo redirect
  // policy is active for this upload (i.e. it would silently move any
  // image/video in this batch there). Null/undefined when no policy applies.
  redirectFolderName?: string | null
  // When set, offers an "Add storage" action in the storage dropdown that
  // opens the storage upgrade modal. Omitted when the user disabled the plus
  // buttons in their profile preferences.
  onAddStorage?: () => void
  // When set, offers a "View detailed breakdown" action in the storage
  // dropdown, showing the user's full per-drive (server & tier) breakdown.
  onViewBreakdown?: () => void
  onConfirm: (ignoreRedirectIndices: Set<number>) => void
  onCancel: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function isMediaFile(f: globalThis.File): boolean {
  return f.type.startsWith('image/') || f.type.startsWith('video/')
}

export function UploadModal({ files, folderName, user, location, redirectFolderName, onAddStorage, onViewBreakdown, onConfirm, onCancel }: Props) {
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
  // Prefer the specific drive this upload will land on so the bar reflects
  // that tier's own quota, not the account-wide total across every drive —
  // fall back to the account aggregate only while the drive hasn't resolved.
  const usedBytes = location ? location.usedBytes : user.storage_used_bytes
  const quotaBytes = location ? location.quotaBytes : user.storage_quota_bytes
  const afterBytes = usedBytes + totalBytes
  const exceedsQuota = afterBytes > quotaBytes

  const usedPct = quotaBytes > 0 ? Math.min((usedBytes / quotaBytes) * 100, 100) : 0
  const uploadPct = quotaBytes > 0 ? Math.min((totalBytes / quotaBytes) * 100, 100 - usedPct) : 0
  const remainingAfter = Math.max(quotaBytes - afterBytes, 0)

  // Files that would be silently redirected into the auto-upload folder.
  // Locked (default) = redirected; unlocked = uploads here instead.
  const redirectActive = !!redirectFolderName
  const lockableIndices = files
    .map((f, i) => (redirectActive && isMediaFile(f) ? i : -1))
    .filter((i) => i >= 0)

  const [unlockedIndices, setUnlockedIndices] = useState<Set<number>>(new Set())
  const [ignoreAll, setIgnoreAll] = useState(false)

  useEffect(() => {
    setUnlockedIndices(new Set())
    setIgnoreAll(false)
  }, [files])

  function toggleLock(i: number) {
    setUnlockedIndices((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  function isFileLocked(i: number): boolean {
    return redirectActive && isMediaFile(files[i]) && !ignoreAll && !unlockedIndices.has(i)
  }

  function handleConfirm() {
    const ignoreRedirectIndices = new Set<number>()
    lockableIndices.forEach((i) => {
      if (ignoreAll || unlockedIndices.has(i)) ignoreRedirectIndices.add(i)
    })
    onConfirm(ignoreRedirectIndices)
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  return (
    <div
      onClick={onCancel}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-125 max-w-[92vw] max-h-[85vh] flex flex-col gap-5 p-6"
      >
        <h3 className="text-base font-semibold text-gray-900 m-0">Upload files</h3>

        <div className="flex flex-col gap-0.5">
          <div className="text-sm text-gray-500 flex items-center gap-1.5">
            Uploading to:
            <span className="font-medium text-gray-900 flex items-center gap-1">
              <MdFolder className="text-blue-500" /> {folderName}
            </span>
          </div>
          {location && (
            <div className="text-xs text-gray-400 flex items-center gap-1">
              {location.isPinned ? 'Pinned to' : 'Default:'}
              <span className="font-medium text-gray-600">{location.name}</span>
              <TierIcon type={location.tier} />
            </div>
          )}
        </div>

        <div className="border border-gray-200 rounded-lg overflow-auto max-h-60 flex-none">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50 sticky top-0">
                <th className="text-left px-3 py-2 font-medium text-gray-600 text-xs">File</th>
                <th className="text-right px-3 py-2 font-medium text-gray-600 text-xs whitespace-nowrap">Size</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-3 py-1.5 max-w-xs text-gray-800">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate" title={f.name}>{f.name}</span>
                      {lockableIndices.includes(i) && (
                        <button
                          type="button"
                          onClick={() => toggleLock(i)}
                          disabled={ignoreAll}
                          title={
                            ignoreAll
                              ? `Redirect ignored for all files — uploading to "${folderName}"`
                              : isFileLocked(i)
                                ? `Will be redirected to "${redirectFolderName}" — click to upload to "${folderName}" instead`
                                : `Will upload to "${folderName}" — click to re-enable the redirect`
                          }
                          className="shrink-0 flex items-center bg-transparent border-0 p-0 text-gray-400 hover:text-gray-600 disabled:opacity-40 disabled:hover:text-gray-400 cursor-pointer disabled:cursor-default"
                        >
                          {isFileLocked(i)
                            ? <MdLock className="text-sm text-purple-500" />
                            : <MdLockOpen className="text-sm" />}
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right text-gray-500 whitespace-nowrap">
                    {formatSize(f.size)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-200 bg-gray-50">
                <td className="px-3 py-1.5 font-semibold text-gray-800">
                  {files.length} file{files.length !== 1 ? 's' : ''}
                </td>
                <td className="px-3 py-1.5 text-right font-semibold text-gray-800 whitespace-nowrap">
                  {formatSize(totalBytes)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex justify-between text-xs text-gray-500">
            <span className="flex items-center gap-1">
              Storage
              {(onAddStorage || onViewBreakdown) && (
                <StorageActionsMenu onAddStorage={onAddStorage} onViewBreakdown={onViewBreakdown} />
              )}
            </span>
            <span>{formatSize(usedBytes)} of {formatSize(quotaBytes)} used</span>
          </div>
          <div className="h-2 rounded-full bg-gray-100 overflow-hidden flex">
            <div className="h-full bg-blue-500 transition-all" style={{ width: `${usedPct}%` }} />
            <div
              className="h-full transition-all"
              style={{ width: `${uploadPct}%`, background: exceedsQuota ? '#ef4444' : '#f97316' }}
            />
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">After upload: {formatSize(afterBytes)}</span>
            {exceedsQuota ? (
              <span className="text-red-500 font-semibold">
                Exceeds quota by {formatSize(afterBytes - quotaBytes)}
              </span>
            ) : (
              <span className="text-gray-500">{formatSize(remainingAfter)} remaining</span>
            )}
          </div>
        </div>

        {lockableIndices.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={ignoreAll}
              onChange={(e) => setIgnoreAll(e.target.checked)}
              className="cursor-pointer"
            />
            Ignore auto-upload redirect for all files (upload here instead of &ldquo;{redirectFolderName}&rdquo;)
          </label>
        )}

        <div className="flex justify-end gap-2 mt-auto">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={exceedsQuota}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-40 cursor-pointer transition-colors"
          >
            {`Upload ${files.length > 1 ? `${files.length} files` : 'file'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// Small dropdown behind the storage bar's actions, replacing what used to be
// a single "Add storage" button — offers that plus a detailed per-drive
// breakdown, without crowding the bar with two separate icon buttons.
function StorageActionsMenu({ onAddStorage, onViewBreakdown }: { onAddStorage?: () => void; onViewBreakdown?: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleOutsideClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Storage actions"
        className="flex items-center bg-transparent border-0 p-0 text-blue-500 hover:text-blue-700 cursor-pointer transition-colors"
      >
        <MdMoreVert className="text-sm" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-48">
          {onAddStorage && (
            <button
              type="button"
              onClick={() => { setOpen(false); onAddStorage() }}
              className="flex items-center gap-2 w-full px-3 py-1.5 bg-transparent border-0 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer text-left transition-colors"
            >
              <MdAddCircleOutline className="text-sm text-blue-500" /> Add storage
            </button>
          )}
          {onViewBreakdown && (
            <button
              type="button"
              onClick={() => { setOpen(false); onViewBreakdown() }}
              className="flex items-center gap-2 w-full px-3 py-1.5 bg-transparent border-0 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer text-left transition-colors"
            >
              <MdPieChart className="text-sm text-gray-500" /> View detailed breakdown
            </button>
          )}
        </div>
      )}
    </div>
  )
}
