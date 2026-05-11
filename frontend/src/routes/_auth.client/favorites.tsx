import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MdFolder, MdInsertDriveFile, MdStar } from 'react-icons/md'
import { favoritesQueryOptions, unfavoriteFile, unfavoriteFolder } from '../../api/favorites'
import { canPreview, FilePreviewModal } from '../../components/FilePreviewModal'
import { useState } from 'react'
import type { File as ApiFile } from '../../types/api'
import { useNotification } from '../../context/NotificationContext'

export const Route = createFileRoute('/_auth/client/favorites')({
  component: RouteComponent,
})

function RouteComponent() {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const { data, isLoading } = useQuery(favoritesQueryOptions)
  const [previewFile, setPreviewFile] = useState<ApiFile | null>(null)

  const removeFileMutation = useMutation({
    mutationFn: unfavoriteFile,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: favoritesQueryOptions.queryKey }),
    onError: () => notify('error', 'Failed to remove from favorites'),
  })

  const removeFolderMutation = useMutation({
    mutationFn: unfavoriteFolder,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: favoritesQueryOptions.queryKey }),
    onError: () => notify('error', 'Failed to remove from favorites'),
  })

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>

  const files = data?.files ?? []
  const folders = data?.folders ?? []
  const isEmpty = files.length === 0 && folders.length === 0

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-6 mt-0">Favorites</h2>

      {isEmpty && (
        <p className="text-sm text-gray-400">
          No favorites yet. Star files or folders to find them here quickly.
        </p>
      )}

      {folders.length > 0 && (
        <section className="mb-6">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Folders</h3>
          <ul className="list-none m-0 p-0 divide-y divide-gray-100">
            {folders.map((folder) => (
              <li key={folder.id} className="flex items-center gap-2 py-2">
                <MdFolder className="text-blue-400 text-lg shrink-0" />
                <Link
                  to="/client"
                  search={{ file: undefined, folder: folder.id }}
                  className="flex-1 text-sm text-gray-800 no-underline hover:text-blue-600 transition-colors"
                >
                  {folder.name}
                </Link>
                <button
                  onClick={() => removeFolderMutation.mutate(folder.id)}
                  disabled={removeFolderMutation.isPending}
                  title="Remove from favorites"
                  className="text-amber-400 hover:text-amber-500 cursor-pointer disabled:opacity-50 bg-transparent border-0 p-0.5"
                >
                  <MdStar className="text-lg" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {files.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Files</h3>
          <ul className="list-none m-0 p-0 divide-y divide-gray-100">
            {files.map((file) => (
              <li key={file.id} className="flex items-center gap-2 py-2">
                <MdInsertDriveFile className="text-gray-400 text-lg shrink-0" />
                <a
                  href={`/api/v1/files/${file.id}/download`}
                  className="flex-1 text-sm text-gray-800 no-underline hover:text-blue-600 transition-colors"
                >
                  {file.name}
                </a>
                <span className="text-xs text-gray-400">{formatSize(file.size_bytes)}</span>
                {canPreview(file.mime_type) && (
                  <button
                    onClick={() => setPreviewFile(file)}
                    className="text-xs text-gray-500 hover:text-gray-900 cursor-pointer bg-transparent border border-gray-200 rounded px-2 py-0.5 hover:border-gray-400 transition-colors"
                  >
                    Preview
                  </button>
                )}
                <button
                  onClick={() => removeFileMutation.mutate(file.id)}
                  disabled={removeFileMutation.isPending}
                  title="Remove from favorites"
                  className="text-amber-400 hover:text-amber-500 cursor-pointer disabled:opacity-50 bg-transparent border-0 p-0.5"
                >
                  <MdStar className="text-lg" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {previewFile && (
        <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      )}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
