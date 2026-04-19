import { createRoute, Link } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Route as AuthLayout } from './AuthLayout'
import { favoritesQueryOptions, unfavoriteFile, unfavoriteFolder } from '../api/favorites'
import { canPreview, FilePreviewModal } from '../components/FilePreviewModal'
import { useState } from 'react'
import type { File as ApiFile } from '../types/api'

export const Route = createRoute({
  getParentRoute: () => AuthLayout,
  path: '/favorites',
  component: FavoritesPage,
})

function FavoritesPage() {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery(favoritesQueryOptions)
  const [previewFile, setPreviewFile] = useState<ApiFile | null>(null)

  const removeFileMutation = useMutation({
    mutationFn: unfavoriteFile,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: favoritesQueryOptions.queryKey }),
  })

  const removeFolderMutation = useMutation({
    mutationFn: unfavoriteFolder,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: favoritesQueryOptions.queryKey }),
  })

  if (isLoading) return <p>Loading…</p>

  const files = data?.files ?? []
  const folders = data?.folders ?? []
  const isEmpty = files.length === 0 && folders.length === 0

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Favorites</h2>

      {isEmpty && (
        <p style={{ color: '#888' }}>
          No favorites yet. Star files or folders to find them here quickly.
        </p>
      )}

      {folders.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, color: '#6b7280', fontWeight: 600, marginBottom: 8 }}>
            FOLDERS
          </h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {folders.map((folder) => (
              <li
                key={folder.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 0',
                  borderBottom: '1px solid #f3f4f6',
                }}
              >
                <span style={{ fontSize: 16 }}>📁</span>
                <Link
                  to="/folders/$folderId"
                  params={{ folderId: folder.id }}
                  style={{ flexGrow: 1, textDecoration: 'none', color: '#111827' }}
                >
                  {folder.name}
                </Link>
                <button
                  onClick={() => removeFolderMutation.mutate(folder.id)}
                  disabled={removeFolderMutation.isPending}
                  title="Remove from favorites"
                  style={starButtonStyle(true)}
                >
                  ★
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {files.length > 0 && (
        <section>
          <h3 style={{ fontSize: 14, color: '#6b7280', fontWeight: 600, marginBottom: 8 }}>
            FILES
          </h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {files.map((file) => (
              <li
                key={file.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 0',
                  borderBottom: '1px solid #f3f4f6',
                }}
              >
                <span style={{ fontSize: 16 }}>📄</span>
                <a
                  href={`/api/v1/files/${file.id}/download`}
                  style={{ flexGrow: 1, textDecoration: 'none', color: '#111827' }}
                >
                  {file.name}
                </a>
                <span style={{ color: '#9ca3af', fontSize: 12 }}>
                  {formatSize(file.size_bytes)}
                </span>
                {canPreview(file.mime_type) && (
                  <button
                    onClick={() => setPreviewFile(file)}
                    style={{ fontSize: 12, cursor: 'pointer' }}
                  >
                    Preview
                  </button>
                )}
                <button
                  onClick={() => removeFileMutation.mutate(file.id)}
                  disabled={removeFileMutation.isPending}
                  title="Remove from favorites"
                  style={starButtonStyle(true)}
                >
                  ★
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

function starButtonStyle(active: boolean): React.CSSProperties {
  return {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 18,
    lineHeight: 1,
    padding: '0 2px',
    color: active ? '#f59e0b' : '#d1d5db',
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
