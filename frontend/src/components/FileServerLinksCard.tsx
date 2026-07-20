import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MdAddCircleOutline, MdLink } from 'react-icons/md'
import { FileServerLinkModal, LinkDisplay, MountGuide } from './FileServerLinkModal'
import { listFileServerLinks, deleteFileServerLink, type FileServerLink } from '../api/fileServerLinks'
import { listMyServers } from '../api/storage'

// useCanCreateFileServerLink reports whether the user still owns at least one
// server/tier combination without a link yet. Once every combination they
// have capacity on already has a link, the "New link" action has nothing
// left to create and should not be offered. Shared by this card's own header
// and the files-sidebar dialog's header (see FilesSidebar.tsx), which needs
// the same answer to decide whether to show its own "New link" button.
export function useCanCreateFileServerLink(existingLinks: FileServerLink[]) {
  const { data: servers = [], isLoading } = useQuery({
    queryKey: ['storage', 'my-servers'],
    queryFn: listMyServers,
  })
  const canCreate = useMemo(() => {
    if (isLoading) return true // don't hide the action before we know
    const linked = new Set(existingLinks.map((l) => l.drive_id))
    return servers.some((s) => !linked.has(s.drive_id))
  }, [servers, existingLinks, isLoading])
  return { canCreate, isLoading }
}

interface FileServerLinksCardProps {
  // Suppresses the card's own title/"New link" row — used when a host modal
  // (the files sidebar dialog) already renders that title bar itself, so the
  // two don't stack into a duplicate header / overlapping buttons.
  hideHeader?: boolean
  // Overrides what happens on "New link" click. Default opens this card's
  // own FileServerLinkModal (own backdrop) — used standalone on the profile
  // page. The files sidebar dialog passes its own handler to switch its
  // internal view instead, keeping a single shared backdrop.
  onNewLink?: () => void
}

// FileServerLinksCard lists the user's premium WebDAV mount links: view,
// copy and delete, plus the creation modal. Rendered only for premium/admin —
// on the profile page and inside the files control panel's dialog.
export function FileServerLinksCard({ hideHeader = false, onNewLink }: FileServerLinksCardProps = {}) {
  const queryClient = useQueryClient()
  const [showModal, setShowModal] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const { data, isLoading: linksLoading } = useQuery({
    queryKey: ['file-server-links'],
    queryFn: listFileServerLinks,
  })
  const links = data?.items ?? []
  const { canCreate } = useCanCreateFileServerLink(links)

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteFileServerLink(id),
    onSettled: () => {
      setConfirmDelete(null)
      queryClient.invalidateQueries({ queryKey: ['file-server-links'] })
    },
  })

  const handleNewLink = onNewLink ?? (() => setShowModal(true))

  return (
    <div className={hideHeader ? undefined : 'bg-white border border-gray-200 rounded-xl px-5 py-4'}>
      {!hideHeader && (
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold text-gray-800 m-0 flex items-center gap-1.5">
            <MdLink className="text-blue-600" /> File server links
          </h3>
          {canCreate && (
            <button
              onClick={handleNewLink}
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 bg-transparent border-0 p-0 cursor-pointer font-medium transition-colors"
            >
              <MdAddCircleOutline className="text-sm" /> New link
            </button>
          )}
        </div>
      )}
      <p className="text-xs text-gray-400 mt-0 mb-3">
        Mount a storage drive as a network drive and manage your files from it — one link per
        server/tier combination you own capacity on.
        {!canCreate && ' You already have a link for every server/tier combination you own.'}
      </p>

      {!linksLoading && (
        <div className="mb-3">
          <MountGuide mountUrl={null} defaultOpen={false} />
        </div>
      )}

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
            <label className="flex items-center gap-1.5 select-none">
              <input
                type="checkbox"
                checked={link.enhanced_security}
                disabled
                readOnly
                className="accent-blue-600"
              />
              <span className="text-[11px] text-gray-500">
                Enhanced security {link.enhanced_security ? 'enabled' : 'disabled'}
              </span>
            </label>
          </div>
        ))}
      </div>

      {!onNewLink && showModal && (
        <FileServerLinkModal
          onClose={() => setShowModal(false)}
          existingLinks={links}
        />
      )}
    </div>
  )
}
