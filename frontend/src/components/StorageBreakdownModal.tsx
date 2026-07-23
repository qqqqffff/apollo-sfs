import { useEffect } from 'react'
import { MdClose } from 'react-icons/md'
import type { MyServer } from '../api/storage'
import { StorageTierBars } from './StorageTierBars'

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

interface Props {
  servers: MyServer[]
  onClose: () => void
}

// Per-drive (server & tier) storage breakdown, shown from the upload modal's
// storage dropdown — reuses the same StorageTierBars list rendered at the
// file browser's "All storage" drive picker.
export function StorageBreakdownModal({ servers, onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const totalUsed = servers.reduce((sum, s) => sum + s.used_bytes, 0)
  const totalQuota = servers.reduce((sum, s) => sum + s.quota_bytes, 0)

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-110 max-w-[92vw] max-h-[85vh] flex flex-col gap-4 p-6"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900 m-0">Storage breakdown</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 cursor-pointer transition-colors bg-transparent border-0 p-0"
          >
            <MdClose className="text-xl" />
          </button>
        </div>

        <p className="text-xs text-gray-400 m-0">
          {formatSize(totalUsed)} of {formatSize(totalQuota)} used across all servers and tiers
        </p>

        <div className="overflow-y-auto">
          {servers.length > 0 ? (
            <StorageTierBars servers={servers} />
          ) : (
            <p className="text-sm text-gray-400 m-0">No drives allocated yet.</p>
          )}
        </div>

        <div className="flex justify-end mt-auto">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 cursor-pointer transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
