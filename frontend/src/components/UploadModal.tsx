import { useEffect } from 'react'
import { MdFolder } from 'react-icons/md'
import type { User } from '../types/api'

interface Props {
  files: globalThis.File[]
  folderName: string
  user: User
  onConfirm: () => void
  onCancel: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function UploadModal({ files, folderName, user, onConfirm, onCancel }: Props) {
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
  const usedBytes = user.storage_used_bytes
  const quotaBytes = user.storage_quota_bytes
  const afterBytes = usedBytes + totalBytes
  const exceedsQuota = afterBytes > quotaBytes

  const usedPct = quotaBytes > 0 ? Math.min((usedBytes / quotaBytes) * 100, 100) : 0
  const uploadPct = quotaBytes > 0 ? Math.min((totalBytes / quotaBytes) * 100, 100 - usedPct) : 0
  const remainingAfter = Math.max(quotaBytes - afterBytes, 0)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

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

        <div className="text-sm text-gray-500 flex items-center gap-1.5">
          Uploading to:
          <span className="font-medium text-gray-900 flex items-center gap-1">
            <MdFolder className="text-blue-500" /> {folderName}
          </span>
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
                  <td className="px-3 py-1.5 overflow-hidden text-ellipsis whitespace-nowrap max-w-xs text-gray-800" title={f.name}>
                    {f.name}
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
            <span>Storage</span>
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

        <div className="flex justify-end gap-2 mt-auto">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
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
