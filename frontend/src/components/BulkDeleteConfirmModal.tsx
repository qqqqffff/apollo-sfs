import { useEffect, useState } from 'react'
import { MdDeleteForever, MdFolder, MdInsertDriveFile } from 'react-icons/md'
import { setSkipDeleteCookie } from './DeleteConfirmModal'

export interface BulkDeleteItem {
  id: string
  name: string
  size_bytes: number
  kind: 'file' | 'folder'
}

interface Props {
  items: BulkDeleteItem[]
  username: string
  // Current used/quota bytes for the storage scope these items live in — the
  // same currentDrive-vs-account-aggregate fallback FolderView's QuotaBar
  // already uses.
  usedBytes: number
  quotaBytes: number
  quotaLabel?: string
  // Items that are part of the deletion but whose metadata isn't loaded, so
  // they can't be listed or sized. Non-zero only for the media grid's
  // filter-driven selection, which can select items beyond the loaded pages.
  unlistedCount?: number
  isPending?: boolean
  onConfirm: () => void
  onCancel: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// BulkDeleteConfirmModal is the multi-select counterpart to DeleteConfirmModal
// — same "don't show this again" cookie (shared via setSkipDeleteCookie) and
// permanence warning, plus a list of everything about to be deleted and a
// quota-impact bar showing how much space it will free.
export function BulkDeleteConfirmModal({
  items, username, usedBytes, quotaBytes, quotaLabel, unlistedCount = 0, isPending, onConfirm, onCancel,
}: Props) {
  const [dontShowAgain, setDontShowAgain] = useState(false)
  const totalBytes = items.reduce((sum, i) => sum + i.size_bytes, 0)
  const totalCount = items.length + unlistedCount
  const afterBytes = Math.max(usedBytes - totalBytes, 0)
  const afterPct = quotaBytes > 0 ? Math.min((afterBytes / quotaBytes) * 100, 100) : 0
  const freedPct = quotaBytes > 0 ? Math.min((totalBytes / quotaBytes) * 100, 100 - afterPct) : 0

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  function handleConfirm() {
    if (dontShowAgain) setSkipDeleteCookie(username)
    onConfirm()
  }

  return (
    <div
      onClick={onCancel}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-125 max-w-[92vw] max-h-[85vh] flex flex-col gap-5 p-6"
      >
        <div className="flex items-start gap-3">
          <MdDeleteForever className="text-red-500 text-2xl shrink-0 mt-0.5" />
          <div>
            <h3 className="text-base font-semibold text-gray-900 m-0 mb-1">
              Delete {totalCount} item{totalCount !== 1 ? 's' : ''} permanently?
            </h3>
            <p className="text-sm text-gray-500 m-0">
              These will be permanently deleted and cannot be recovered.
            </p>
          </div>
        </div>

        <div className="border border-gray-200 rounded-lg overflow-auto max-h-40 flex-none">
          <table className="w-full text-sm border-collapse">
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t border-gray-100 first:border-t-0">
                  <td className="px-3 py-1.5 text-gray-800">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {item.kind === 'folder'
                        ? <MdFolder className="text-blue-400 shrink-0" />
                        : <MdInsertDriveFile className="text-gray-400 shrink-0" />}
                      <span className="truncate" title={item.name}>{item.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right text-gray-500 whitespace-nowrap">
                    {formatSize(item.size_bytes)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {unlistedCount > 0 && (
                <tr className="border-t border-gray-100">
                  <td colSpan={2} className="px-3 py-1.5 text-xs text-gray-500 italic">
                    + {unlistedCount} more selected item{unlistedCount !== 1 ? 's' : ''} not
                    loaded in this view — they will be deleted too, but aren’t counted in the
                    size below.
                  </td>
                </tr>
              )}
              <tr className="border-t-2 border-gray-200 bg-gray-50">
                <td className="px-3 py-1.5 font-semibold text-gray-800">
                  {items.length} {unlistedCount > 0 ? 'listed ' : ''}item{items.length !== 1 ? 's' : ''}
                </td>
                <td className="px-3 py-1.5 text-right font-semibold text-gray-800 whitespace-nowrap">
                  {formatSize(totalBytes)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {quotaBytes > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex justify-between text-xs text-gray-500">
              <span>{quotaLabel ?? 'Storage'}</span>
              <span>{formatSize(usedBytes)} of {formatSize(quotaBytes)} used</span>
            </div>
            <div className="h-2 rounded-full bg-gray-100 overflow-hidden flex">
              <div className="h-full bg-blue-500 transition-all" style={{ width: `${afterPct}%` }} />
              <div className="h-full bg-emerald-400 transition-all" style={{ width: `${freedPct}%` }} />
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-500">After deletion: {formatSize(afterBytes)} used</span>
              <span className="text-emerald-600 font-medium">{formatSize(totalBytes)} freed</span>
            </div>
          </div>
        )}

        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 accent-blue-600 cursor-pointer"
          />
          <span className="text-sm text-gray-500">Don't show this confirmation again</span>
        </label>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={isPending}
            className="px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
