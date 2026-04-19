import { createRoute, Link, useParams } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import type React from 'react'
import { Route as AuthLayout } from './AuthLayout'
import { createFolder, deleteFolder } from '../api/folders'
import { deleteFile, moveFile } from '../api/files'
import { meQueryOptions } from '../api/me'
import { FilePreviewModal, canPreview } from '../components/FilePreviewModal'
import { UploadModal } from '../components/UploadModal'
import { UploadToast } from '../components/UploadToast'
import { SortControls } from '../components/SortControls'
import { SearchBar } from '../components/SearchBar'
import { useFileUpload } from '../hooks/useFileUpload'
import { useDragDrop } from '../hooks/useDragDrop'
import { useFileDrag } from '../hooks/useFileDrag'
import { useSort, sortedFolders, sortedFiles } from '../hooks/useSort'
import { useInfiniteFolderContents } from '../hooks/useInfiniteFolderContents'
import { useFavorites } from '../hooks/useFavorites'
import type { File as ApiFile } from '../types/api'

export const Route = createRoute({
  getParentRoute: () => AuthLayout,
  path: '/folders/$folderId',
  component: FolderPage,
})

function FolderPage() {
  const { folderId } = useParams({ from: '/folders/$folderId' })
  const queryClient = useQueryClient()
  const { data: user } = useQuery(meQueryOptions)
  const fileRef = useRef<HTMLInputElement>(null)
  const [previewFile, setPreviewFile] = useState<ApiFile | null>(null)
  const [pendingFiles, setPendingFiles] = useState<globalThis.File[]>([])
  const [search, setSearch] = useState('')
  const { progress, startUpload, dismiss } = useFileUpload()
  const { isDragging } = useDragDrop((dropped) => setPendingFiles(dropped))
  const { sort, onSort } = useSort()
  const { favoriteFileIds, favoriteFolderIds, toggleFile, toggleFolder } = useFavorites()

  const {
    folder,
    folders: rawSubfolders,
    files: rawFiles,
    isLoading,
    error,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteFolderContents(folderId, search)

  const moveFileMutation = useMutation({
    mutationFn: ({ fileId, targetFolderId }: { fileId: string; targetFolderId: string }) =>
      moveFile(fileId, targetFolderId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['folders'] }),
  })

  const { draggingFileId, dragOverFolderId, getFileDragHandlers, getFolderDropHandlers } =
    useFileDrag((fileId, targetFolderId) => moveFileMutation.mutate({ fileId, targetFolderId }))

  const createFolderMutation = useMutation({
    mutationFn: (name: string) => createFolder(name, folderId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['folders', folderId] }),
  })

  const deleteFolderMutation = useMutation({
    mutationFn: deleteFolder,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['folders'] }),
  })

  const deleteFileMutation = useMutation({
    mutationFn: deleteFile,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['folders', folderId] }),
  })

  if (isLoading) return <p>Loading…</p>
  if (error) return <p>Folder not found.</p>

  const subfolders = sortedFolders(rawSubfolders, sort)
  const files = sortedFiles(rawFiles, sort)

  const hasContent = rawSubfolders.length > 0 || rawFiles.length > 0
  const noResults = search && !isLoading && !hasNextPage && !hasContent

  return (
    <div>
      <nav style={{ marginBottom: 8 }}>
        <Link to="/dashboard">Home</Link>
        {folder?.parent_id && (
          <>
            {' / '}
            <Link to="/folders/$folderId" params={{ folderId: folder.parent_id }}>
              Parent
            </Link>
          </>
        )}
        {' / '}
        <strong>{folder?.name}</strong>
      </nav>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          onClick={() => {
            const name = prompt('Folder name')
            if (name) createFolderMutation.mutate(name)
          }}
        >
          New folder
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const selected = Array.from(e.target.files ?? [])
            if (selected.length > 0) setPendingFiles(selected)
            e.target.value = ''
          }}
        />
        <button onClick={() => fileRef.current?.click()}>Upload file</button>
      </div>

      <SearchBar value={search} onChange={setSearch} />

      {!search && !hasContent && <p style={{ color: '#888' }}>This folder is empty.</p>}

      {noResults && (
        <p style={{ color: '#888' }}>No results for &ldquo;{search}&rdquo;.</p>
      )}

      {hasContent && <SortControls sort={sort} onSort={onSort} />}

      {subfolders.length > 0 && (
        <section>
          <h3>Folders</h3>
          <ul>
            {subfolders.map((f) => (
              <li
                key={f.id}
                {...getFolderDropHandlers(f)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: dragOverFolderId === f.id ? '#dbeafe' : undefined,
                  outline: dragOverFolderId === f.id ? '2px dashed #4a90e2' : undefined,
                }}
              >
                <Link to="/folders/$folderId" params={{ folderId: f.id }} style={{ flexGrow: 1 }}>
                  📁 {f.name}
                </Link>
                <button
                  onClick={() => toggleFolder(f.id)}
                  title={favoriteFolderIds.has(f.id) ? 'Remove from favorites' : 'Add to favorites'}
                  style={starButtonStyle(favoriteFolderIds.has(f.id))}
                >
                  {favoriteFolderIds.has(f.id) ? '★' : '☆'}
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete folder "${f.name}"?`)) {
                      deleteFolderMutation.mutate(f.id)
                    }
                  }}
                  style={{ fontSize: 12 }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {files.length > 0 && (
        <section>
          <h3>Files</h3>
          <ul>
            {files.map((f) => (
              <li
                key={f.id}
                {...getFileDragHandlers(f)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  opacity: draggingFileId === f.id ? 0.4 : 1,
                  cursor: 'grab',
                }}
              >
                <a href={`/api/v1/files/${f.id}/download`} style={{ flexGrow: 1 }}>{f.name}</a>
                <span style={{ color: '#888', fontSize: 12 }}>
                  ({(f.size_bytes / 1024).toFixed(1)} KB)
                </span>
                {canPreview(f.mime_type) && (
                  <button onClick={() => setPreviewFile(f)} style={{ fontSize: 12 }}>
                    Preview
                  </button>
                )}
                <button
                  onClick={() => toggleFile(f.id)}
                  title={favoriteFileIds.has(f.id) ? 'Remove from favorites' : 'Add to favorites'}
                  style={starButtonStyle(favoriteFileIds.has(f.id))}
                >
                  {favoriteFileIds.has(f.id) ? '★' : '☆'}
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete "${f.name}"?`)) {
                      deleteFileMutation.mutate(f.id)
                    }
                  }}
                  style={{ fontSize: 12 }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {hasNextPage && (
        <button
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          style={{ marginTop: 8, fontSize: 13 }}
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}

      {previewFile && (
        <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      )}

      {pendingFiles.length > 0 && user && (
        <UploadModal
          files={pendingFiles}
          folderName={folder?.name ?? 'This folder'}
          user={user}
          onConfirm={() => {
            const filesToUpload = pendingFiles
            setPendingFiles([])
            startUpload(filesToUpload, folderId, () => {
              queryClient.invalidateQueries({ queryKey: ['folders', folderId] })
              queryClient.invalidateQueries({ queryKey: ['me'] })
            })
          }}
          onCancel={() => setPendingFiles([])}
        />
      )}

      <UploadToast progress={progress} onDismiss={dismiss} />

      {isDragging && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(74, 144, 226, 0.1)',
            border: '3px dashed #4a90e2',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 999,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              background: 'rgba(255,255,255,0.95)',
              borderRadius: 12,
              padding: '24px 48px',
              textAlign: 'center',
              boxShadow: '0 4px 24px rgba(74,144,226,0.2)',
            }}
          >
            <div style={{ fontSize: 36, marginBottom: 8 }}>📂</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: '#4a90e2' }}>
              Drop files to upload
            </div>
            <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>
              to {folder?.name ?? 'this folder'}
            </div>
          </div>
        </div>
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
