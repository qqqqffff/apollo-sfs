import { useEffect, useState } from 'react'
import { MdClose, MdFolder, MdInsertDriveFile } from 'react-icons/md'
import { FolderTreePicker } from './FolderTreePicker'

export interface BulkMoveItem {
  id: string
  name: string
  size_bytes: number
  kind: 'file' | 'folder'
}

interface Props {
  items: BulkMoveItem[]
  driveId: string
  includeUnassigned: boolean
  isPending?: boolean
  onConfirm: (targetFolderId: string) => void
  onClose: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// BulkMoveModal moves a multi-selection at once — the list of items being
// moved above a FolderTreePicker scoped to the drive they already live on
// (same-drive moves only, see FolderTreePicker's comment).
export function BulkMoveModal({ items, driveId, includeUnassigned, isPending, onConfirm, onClose }: Props) {
  const [destParentId, setDestParentId] = useState<string | null>(null)
  const excludeFolderIds = items.filter((i) => i.kind === 'folder').map((i) => i.id)
  const totalBytes = items.reduce((sum, i) => sum + i.size_bytes, 0)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-125 max-w-[92vw] max-h-[85vh] flex flex-col gap-4 p-6"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900 m-0">
            Move {items.length} item{items.length !== 1 ? 's' : ''}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 cursor-pointer transition-colors bg-transparent border-0 p-0"
          >
            <MdClose className="text-xl" />
          </button>
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
              <tr className="border-t-2 border-gray-200 bg-gray-50">
                <td className="px-3 py-1.5 font-semibold text-gray-800">
                  {items.length} item{items.length !== 1 ? 's' : ''}
                </td>
                <td className="px-3 py-1.5 text-right font-semibold text-gray-800 whitespace-nowrap">
                  {formatSize(totalBytes)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div>
          <p className="text-xs text-gray-500 mb-1.5">Move into which folder?</p>
          <FolderTreePicker
            driveId={driveId}
            includeUnassigned={includeUnassigned}
            excludeFolderIds={excludeFolderIds}
            value={destParentId}
            onSelect={(id) => setDestParentId(id)}
          />
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => destParentId && onConfirm(destParentId)}
            disabled={!destParentId || isPending}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isPending ? 'Moving…' : 'Move here'}
          </button>
        </div>
      </div>
    </div>
  )
}
