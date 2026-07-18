import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MdAutoAwesome, MdClose, MdInfoOutline, MdPhotoLibrary } from 'react-icons/md'
import { recognitionStatusQueryOptions, setRecognitionEnabled } from '../api/recognition'
import { useNotification } from '../context/NotificationContext'
import type { Folder } from '../types/api'

interface Props {
  folder: Folder
  isPremium: boolean
  readOnly: boolean
  onClose: () => void
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// CollectionInfoModal shows a media collection's details and hosts the AI
// recognition toggle. Enabling requires confirming a disclaimer (server-side
// analysis + crops count toward the storage quota); disabling offers an
// optional purge of all recognition data.
export function CollectionInfoModal({ folder, isPremium, readOnly, onClose }: Props) {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const [confirming, setConfirming] = useState<'enable' | 'disable' | null>(null)
  const [purge, setPurge] = useState(false)

  const { data: status } = useQuery(recognitionStatusQueryOptions(folder.id, isPremium))

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handler)
      document.body.style.overflow = ''
    }
  }, [onClose])

  const toggleMutation = useMutation({
    mutationFn: ({ enabled, purgeData }: { enabled: boolean; purgeData: boolean }) =>
      setRecognitionEnabled(folder.id, enabled, purgeData),
    onSuccess: (res) => {
      setConfirming(null)
      setPurge(false)
      queryClient.invalidateQueries({ queryKey: ['recognition', folder.id] })
      queryClient.invalidateQueries({ queryKey: ['folders'] })
      if (res.enabled) {
        notify('success', `AI recognition enabled — ${res.files_enqueued} files queued for indexing`)
      } else {
        notify('success', res.freed_bytes > 0
          ? `AI recognition disabled — ${fmtBytes(res.freed_bytes)} freed`
          : 'AI recognition disabled')
      }
    },
    onError: () => notify('error', 'Failed to update AI recognition setting'),
  })

  const enabled = status?.enabled ?? folder.ai_recognition_enabled
  const indexing = (status?.counts.pending ?? 0) + (status?.counts.processing ?? 0)
  const indexed = status?.counts.done ?? 0
  const total = indexing + indexed + (status?.counts.failed ?? 0) + (status?.counts.skipped ?? 0)

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-md flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
          <MdInfoOutline className="text-blue-500 text-lg" />
          <h3 className="text-sm font-semibold text-gray-900 m-0 flex-1 truncate">Collection info</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 bg-transparent border-0 p-0.5 cursor-pointer"
            aria-label="Close"
          >
            <MdClose className="text-lg" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Collection facts */}
          <div className="flex items-center gap-2">
            <MdPhotoLibrary className="text-purple-400 text-2xl shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-900 truncate">{folder.name}</div>
              <div className="text-xs text-gray-500">
                Media collection · {folder.size_bytes > 0 ? fmtBytes(folder.size_bytes) : '—'} · created{' '}
                {new Date(folder.created_at).toLocaleDateString()}
              </div>
            </div>
          </div>

          {/* AI recognition */}
          <div className="bg-gray-50 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex-1 mr-4">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                  <MdAutoAwesome className="text-amber-500" /> AI recognition
                </div>
                <div className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                  Group similar faces, identify unique pets, and label common objects across this
                  collection. Labeled groups become searchable.
                </div>
              </div>
              <label className={`relative inline-flex shrink-0 ${isPremium && !readOnly ? 'cursor-pointer' : 'opacity-40'}`}>
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={enabled}
                  disabled={!isPremium || readOnly || toggleMutation.isPending || !!confirming}
                  onChange={(e) => setConfirming(e.target.checked ? 'enable' : 'disable')}
                />
                <div className="w-10 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:start-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
              </label>
            </div>

            {!isPremium && (
              <p className="text-xs text-amber-600 m-0">
                AI recognition is a premium feature.{' '}
                <a href="/premium" className="underline">Upgrade to Premium</a> to enable it.
              </p>
            )}

            {/* Enable disclaimer */}
            {confirming === 'enable' && (
              <div className="border border-amber-200 bg-amber-50 rounded-lg p-3 space-y-2">
                <p className="text-xs text-gray-700 m-0 leading-relaxed">
                  Photos and videos in this collection will be analyzed on the server to detect
                  faces, pets, and objects. Small encrypted thumbnails of detected faces and pets
                  are stored in your storage and <strong>count toward your storage quota</strong>.
                  Indexing runs in a capped background pool and can take a while for large
                  collections. You can disable this at any time and optionally delete all
                  recognition data.
                </p>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setConfirming(null)}
                    className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg border border-gray-200 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => toggleMutation.mutate({ enabled: true, purgeData: false })}
                    disabled={toggleMutation.isPending}
                    className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer disabled:opacity-50"
                  >
                    {toggleMutation.isPending ? 'Enabling…' : 'Enable AI recognition'}
                  </button>
                </div>
              </div>
            )}

            {/* Disable confirm (+ optional purge) */}
            {confirming === 'disable' && (
              <div className="border border-gray-200 bg-white rounded-lg p-3 space-y-2">
                <p className="text-xs text-gray-700 m-0">
                  Stop indexing this collection? Existing groups are kept unless you also delete
                  the recognition data.
                </p>
                <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
                  Also delete groups, detections, and stored thumbnails
                  {status && status.storage_bytes > 0 && ` (frees ${fmtBytes(status.storage_bytes)})`}
                </label>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => { setConfirming(null); setPurge(false) }}
                    className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg border border-gray-200 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => toggleMutation.mutate({ enabled: false, purgeData: purge })}
                    disabled={toggleMutation.isPending}
                    className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium cursor-pointer disabled:opacity-50"
                  >
                    {toggleMutation.isPending ? 'Disabling…' : purge ? 'Disable & delete data' : 'Disable'}
                  </button>
                </div>
              </div>
            )}

            {/* Indexing progress */}
            {enabled && status && total > 0 && (
              <div>
                <div className="flex justify-between text-[11px] text-gray-500 mb-1">
                  <span>{indexing > 0 ? `Indexing ${indexed}/${total}…` : 'Up to date'}</span>
                  {status.storage_bytes > 0 && <span>{fmtBytes(status.storage_bytes)} used</span>}
                </div>
                <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all"
                    style={{ width: `${total > 0 ? Math.round((indexed / total) * 100) : 0}%` }}
                  />
                </div>
              </div>
            )}

            {enabled && status && !status.service_available && (
              <p className="text-xs text-red-500 m-0">Recognition service is currently unavailable.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
