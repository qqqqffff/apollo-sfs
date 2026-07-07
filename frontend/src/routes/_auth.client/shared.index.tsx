import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  MdCheck,
  MdContentCopy,
  MdFolder,
  MdFolderShared,
  MdInsertDriveFile,
  MdLinkOff,
} from 'react-icons/md'
import { mySharesQueryOptions, revokeShare, sharedWithMeQueryOptions } from '../../api/shares'
import { useNotification } from '../../context/NotificationContext'
import { FilesLayout } from '../../components/FilesSidebar'
import type { Share } from '../../types/api'

export const Route = createFileRoute('/_auth/client/shared/')({
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <FilesLayout>
      <SharedView />
    </FilesLayout>
  )
}

function SharedView() {
  const queryClient = useQueryClient()
  const { notify } = useNotification()

  const { data: withMe, isLoading: withMeLoading } = useQuery(sharedWithMeQueryOptions)
  const { data: mine, isLoading: mineLoading } = useQuery(mySharesQueryOptions)

  const revokeMutation = useMutation({
    mutationFn: revokeShare,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shares', 'mine'] }),
    onError: () => notify('error', 'Failed to revoke share'),
  })

  if (withMeLoading || mineLoading) return <p className="text-sm text-gray-500">Loading…</p>

  const sharedWithMe = withMe?.shares ?? []
  const myShares = mine?.shares ?? []

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-6 mt-0">Shared</h2>

      <section className="mb-8">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          Shared with me
        </h3>
        {sharedWithMe.length === 0 ? (
          <p className="text-sm text-gray-400">
            Nothing has been shared with you yet.
          </p>
        ) : (
          <ul className="list-none m-0 p-0 divide-y divide-gray-100">
            {sharedWithMe.map((s) => (
              <li key={s.id} className="flex items-center gap-2 py-2">
                <ShareItemIcon share={s} />
                <Link
                  to="/client/shared/$shareId"
                  params={{ shareId: s.id }}
                  search={{ folder: undefined, file: undefined }}
                  className="flex-1 min-w-0 text-sm text-gray-800 no-underline hover:text-blue-600 transition-colors truncate"
                >
                  {s.item_name}
                </Link>
                <span className="text-xs text-gray-400 shrink-0 hidden sm:inline">
                  from {s.owner_email}
                </span>
                <PermissionBadge share={s} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          Shared by me
        </h3>
        {myShares.length === 0 ? (
          <p className="text-sm text-gray-400">
            You haven&apos;t shared anything. Use the share icon next to a file or folder.
          </p>
        ) : (
          <ul className="list-none m-0 p-0 divide-y divide-gray-100">
            {myShares.map((s) => (
              <li key={s.id} className="flex items-center gap-2 py-2">
                <ShareItemIcon share={s} />
                <span className="flex-1 min-w-0 text-sm text-gray-800 truncate">{s.item_name}</span>
                <span className="text-xs text-gray-400 shrink-0 hidden sm:inline">
                  to {s.recipient_email}
                </span>
                <PermissionBadge share={s} />
                <CopyLinkButton url={s.share_url} />
                <button
                  onClick={() => revokeMutation.mutate(s.id)}
                  disabled={revokeMutation.isPending}
                  title="Revoke share"
                  className="cursor-pointer bg-transparent border-0 p-0.5 text-gray-300 hover:text-red-500 transition-colors disabled:opacity-50"
                >
                  <MdLinkOff className="text-lg" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function ShareItemIcon({ share }: { share: Share }) {
  if (share.item_type === 'folder') {
    return share.include_children
      ? <MdFolderShared className="text-blue-400 text-lg shrink-0" />
      : <MdFolder className="text-blue-400 text-lg shrink-0" />
  }
  return <MdInsertDriveFile className="text-gray-400 text-lg shrink-0" />
}

function PermissionBadge({ share }: { share: Share }) {
  const label =
    share.item_type === 'folder'
      ? share.can_upload ? 'view · upload · download' : share.can_download ? 'view · download' : 'view only'
      : share.can_download ? 'view · download' : 'view only'
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 shrink-0 whitespace-nowrap">
      {label}
    </span>
  )
}

function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard unavailable — ignore.
    }
  }
  return (
    <button
      onClick={copy}
      title="Copy share link"
      className={`cursor-pointer bg-transparent border-0 p-0.5 transition-colors ${copied ? 'text-green-500' : 'text-gray-300 hover:text-blue-500'}`}
    >
      {copied ? <MdCheck className="text-lg" /> : <MdContentCopy className="text-lg" />}
    </button>
  )
}
