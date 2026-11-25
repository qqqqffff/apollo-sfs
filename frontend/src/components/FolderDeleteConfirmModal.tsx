import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MdDeleteForever, MdFolder, MdInsertDriveFile } from 'react-icons/md'
import { setSkipDeleteCookie } from './DeleteConfirmModal'
import { enumerateFolderContents } from '../hooks/useDeleteJob'

// How many rows the preview table renders before collapsing the rest into a
// "+N more" footer note — enumerating a folder with thousands of backed-up
// emails shouldn't mean rendering thousands of table rows.
const PREVIEW_ROW_CAP = 200

interface Props {
  folder: { id: string; name: string; sizeBytes: number }
  username: string
  // Current used/quota bytes for the storage scope this folder lives in —
  // the same currentDrive-vs-account-aggregate fallback BulkDeleteConfirmModal
  // and FolderView's QuotaBar already use.
  usedBytes: number
  quotaBytes: number
  quotaLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// FolderDeleteConfirmModal is the single-folder counterpart to
// BulkDeleteConfirmModal — deleting a folder now cascades through its whole
// subtree (see useDeleteJob), so this mirrors that modal's preview table of
// everything about to go and the quota-impact bar, instead of the plain
// one-line warning DeleteConfirmModal gives a single file.
export function FolderDeleteConfirmModal({
  folder, username, usedBytes, quotaBytes, quotaLabel, onConfirm, onCancel,
}: Props) {
  const [dontShowAgain, setDontShowAgain] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['folder-delete-preview', folder.id],
    queryFn: () => enumerateFolderContents(folder.id),
  })
  const files = data?.files ?? []
  const subfolderCount = data ? Math.max(data.folderIdsPostOrder.length - 1, 0) : 0
  const shown = files.slice(0, PREVIEW_ROW_CAP)
  const hiddenCount = files.length - shown.length

  const afterBytes = Math.max(usedBytes - folder.sizeBytes, 0)
  const afterPct = quotaBytes > 0 ? Math.min((afterBytes / quotaBytes) * 100, 100) : 0
  const freedPct = quotaBytes > 0 ? Math.min((folder.sizeBytes / quotaBytes) * 100, 100 - afterPct) : 0

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
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-gray-900 m-0 mb-1 break-words">
              Delete "{folder.name}" permanently?
            </h3>
            <p className="text-sm text-gray-500 m-0">
              {subfolderCount > 0
                ? `This folder and everything inside it — including ${subfolderCount} subfolder${subfolderCount !== 1 ? 's' : ''} — will be permanently deleted and cannot be recovered.`
                : 'This folder and everything inside it will be permanently deleted and cannot be recovered.'}
            </p>
          </div>
        </div>

        <div className="border border-gray-200 rounded-lg overflow-auto max-h-40 flex-none">
          {isLoading ? (
            <p className="px-3 py-4 text-sm text-gray-400 text-center m-0">Loading contents…</p>
          ) : error ? (
            <p className="px-3 py-4 text-sm text-red-500 text-center m-0">Could not load this folder's contents.</p>
          ) : files.length === 0 ? (
            <p className="px-3 py-4 text-sm text-gray-400 text-center m-0">This folder is empty.</p>
          ) : (
            <table className="w-full text-sm border-collapse">
              <tbody>
                {shown.map((file) => (
                  <tr key={file.id} className="border-t border-gray-100 first:border-t-0">
                    <td className="px-3 py-1.5 text-gray-800">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <MdInsertDriveFile className="text-gray-400 shrink-0" />
                        <span className="truncate" title={file.name}>{file.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right text-gray-500 whitespace-nowrap">
                      {formatSize(file.size_bytes)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {hiddenCount > 0 && (
                  <tr className="border-t border-gray-100">
                    <td colSpan={2} className="px-3 py-1.5 text-xs text-gray-500 italic">
                      + {hiddenCount} more file{hiddenCount !== 1 ? 's' : ''} (included in the total below).
                    </td>
                  </tr>
                )}
                <tr className="border-t-2 border-gray-200 bg-gray-50">
                  <td className="px-3 py-1.5 font-semibold text-gray-800">
                    <div className="flex items-center gap-1.5">
                      <MdFolder className="text-blue-400 shrink-0" />
                      {files.length} file{files.length !== 1 ? 's' : ''}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right font-semibold text-gray-800 whitespace-nowrap">
                    {formatSize(folder.sizeBytes)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
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
              <span className="text-emerald-600 font-medium">{formatSize(folder.sizeBytes)} freed</span>
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
            className="px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium cursor-pointer transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
