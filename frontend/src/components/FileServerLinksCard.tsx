import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MdAddCircleOutline, MdLink } from 'react-icons/md'
import { FileServerLinkModal, LinkDisplay } from './FileServerLinkModal'
import { listFileServerLinks, deleteFileServerLink } from '../api/fileServerLinks'

// FileServerLinksCard lists the user's premium WebDAV mount links: view,
// copy and delete, plus the creation modal. Rendered only for premium/admin —
// on the profile page and inside the files control panel's dialog.
export function FileServerLinksCard() {
  const queryClient = useQueryClient()
  const [showModal, setShowModal] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const { data, isLoading: linksLoading } = useQuery({
    queryKey: ['file-server-links'],
    queryFn: listFileServerLinks,
  })
  const links = data?.items ?? []

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteFileServerLink(id),
    onSettled: () => {
      setConfirmDelete(null)
      queryClient.invalidateQueries({ queryKey: ['file-server-links'] })
    },
  })

  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-gray-800 m-0 flex items-center gap-1.5">
          <MdLink className="text-blue-600" /> File server links
        </h3>
        <button
          onClick={() => setShowModal(true)}
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 bg-transparent border-0 p-0 cursor-pointer font-medium transition-colors"
        >
          <MdAddCircleOutline className="text-sm" /> New link
        </button>
      </div>
      <p className="text-xs text-gray-400 mt-0 mb-3">
        Mount a storage drive as a network drive and manage your files from it — one link per
        server/tier combination you own capacity on.
      </p>

      {linksLoading && <p className="text-xs text-gray-400 m-0">Loading…</p>}
      {!linksLoading && links.length === 0 && (
        <p className="text-xs text-gray-400 m-0">No links yet.</p>
      )}

      <div className="space-y-3">
        {links.map((link) => (
          <div key={link.id} className="border border-gray-100 rounded-lg px-3 py-2.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 min-w-0">
                <span className="text-sm text-gray-800 font-medium truncate">{link.server_name}</span>
                <span
                  className={`text-[10px] font-medium rounded px-1.5 py-0.5 shrink-0 ${
                    link.drive_type === 'nvme'
                      ? 'text-emerald-700 bg-emerald-100'
                      : 'text-sky-700 bg-sky-100'
                  }`}
                >
                  {link.drive_type === 'nvme' ? 'Fast' : 'Standard'}
                </span>
                {link.enhanced_security && (
                  <span className="text-[10px] font-medium text-green-700 bg-green-50 rounded px-1.5 py-0.5 shrink-0">
                    enhanced security
                  </span>
                )}
              </span>
              {confirmDelete === link.id ? (
                <span className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => deleteMutation.mutate(link.id)}
                    disabled={deleteMutation.isPending}
                    className="text-[11px] font-medium text-red-600 hover:text-red-700 bg-transparent border-0 p-0 cursor-pointer disabled:opacity-50"
                  >
                    {deleteMutation.isPending ? 'Deleting…' : 'Confirm delete'}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(null)}
                    className="text-[11px] text-gray-400 hover:text-gray-600 bg-transparent border-0 p-0 cursor-pointer"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmDelete(link.id)}
                  className="text-[11px] text-gray-400 hover:text-red-600 bg-transparent border-0 p-0 cursor-pointer transition-colors shrink-0"
                >
                  Delete
                </button>
              )}
            </div>
            <LinkDisplay link={link} />
            <p className="text-[11px] text-gray-400 m-0">
              Created {new Date(link.created_at).toLocaleDateString()}
              {link.last_used_at ? ` · last used ${new Date(link.last_used_at).toLocaleString()}` : ' · never used'}
            </p>
          </div>
        ))}
      </div>

      {showModal && (
        <FileServerLinkModal
          onClose={() => setShowModal(false)}
          existingLinks={links}
        />
      )}
    </div>
  )
}
