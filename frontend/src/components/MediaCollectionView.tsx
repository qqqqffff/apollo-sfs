import { useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MdAdd,
  MdArrowBack,
  MdCheck,
  MdClose,
  MdCreateNewFolder,
  MdMovie,
  MdInsertDriveFile,
  MdPhotoLibrary,
  MdUploadFile,
  MdVisibility,
  MdVisibilityOff,
} from 'react-icons/md'
import { getMediaFolder, createFolder } from '../api/folders'
import { hideFile, unhideFile, previewUrl } from '../api/files'
import { copyToCollection, removeFromCollection } from '../api/collections'
import { meQueryOptions } from '../api/me'
import { useNotification } from '../context/NotificationContext'
import { useFileUpload } from '../hooks/useFileUpload'
import { UploadModal } from './UploadModal'
import { UploadToast } from './UploadToast'
import type { File, Folder, HiddenMode, MediaSort } from '../types/api'

interface Props {
  folderId: string
  folder: Folder
  readOnly: boolean
  onBack: () => void
  onOpenFolder: (id: string) => void
  onOpenFile: (id: string) => void
}

// useInfiniteMedia paginates a media collection's files (and first-page subfolders).
function useInfiniteMedia(folderId: string, sort: MediaSort, hidden: HiddenMode) {
  const query = useInfiniteQuery({
    queryKey: ['media', folderId, sort, hidden],
    queryFn: ({ pageParam }) =>
      getMediaFolder(folderId, { sort, hidden, fileCursor: pageParam || undefined, folderLimit: pageParam ? 0 : undefined }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.files.next_token || undefined,
  })
  return {
    folder: query.data?.pages[0]?.folder ?? null,
    subfolders: query.data?.pages[0]?.subfolders.items ?? [],
    files: query.data?.pages.flatMap((p) => p.files.items) ?? [],
    isLoading: query.isLoading,
    error: query.error,
    hasNextPage: query.hasNextPage ?? false,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
  }
}

export function MediaCollectionView({ folderId, folder, readOnly, onBack, onOpenFolder, onOpenFile }: Props) {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const { data: user } = useQuery(meQueryOptions)
  const [sort, setSort] = useState<MediaSort>('taken_at')
  const [hidden, setHidden] = useState<HiddenMode>('hide')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [pendingFiles, setPendingFiles] = useState<globalThis.File[]>([])
  const { progress, startUpload, dismiss } = useFileUpload()

  const { subfolders, files, isLoading, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteMedia(folderId, sort, hidden)

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['media', folderId] })
  }

  const createSub = useMutation({
    mutationFn: (name: string) => createFolder(name, folderId, 'media'),
    onSuccess: () => { setCreating(false); setNewName(''); invalidate() },
    onError: () => notify('error', 'Failed to create subcollection'),
  })

  const hideMutation = useMutation({
    mutationFn: ({ id, hide }: { id: string; hide: boolean }) => (hide ? hideFile(id) : unhideFile(id)),
    onSuccess: invalidate,
    onError: () => notify('error', 'Failed to update file'),
  })

  const copyMutation = useMutation({
    mutationFn: ({ collectionId, fileId }: { collectionId: string; fileId: string }) =>
      copyToCollection(collectionId, fileId),
    onSuccess: () => { notify('success', 'Added to collection'); invalidate() },
    onError: () => notify('error', 'Failed to add to collection'),
  })

  const removeMutation = useMutation({
    mutationFn: (fileId: string) => removeFromCollection(folderId, fileId),
    onSuccess: invalidate,
    onError: () => notify('error', 'Failed to remove from collection'),
  })

  // When viewing a subcollection (not the top-level media folder), items may be
  // pointers that can be removed from this collection.
  const isSubcollection = folder.parent_id !== null

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (error) return <p className="text-sm text-red-500">Failed to load collection.</p>

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 cursor-pointer bg-transparent border-0 p-0 transition-colors"
        >
          <MdArrowBack className="text-base" /> Back
        </button>
        <MdPhotoLibrary className="text-purple-400 text-lg" />
        <h2 className="text-lg font-semibold text-gray-900 m-0">{folder.name}</h2>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as MediaSort)}
          className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
        >
          <option value="taken_at">Date taken</option>
          <option value="created_at">Date uploaded</option>
          <option value="name">Name</option>
        </select>

        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
          <ToggleBtn active={hidden === 'hide'} onClick={() => setHidden('hide')} label="Visible" />
          <ToggleBtn active={hidden === 'show'} onClick={() => setHidden('show')} label="Show hidden" />
          <ToggleBtn active={hidden === 'only'} onClick={() => setHidden('only')} label="Hidden" />
        </div>

        {!readOnly && (
          <>
            <button
              onClick={() => { setCreating(true); setNewName('') }}
              disabled={creating}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 cursor-pointer transition-colors disabled:opacity-40"
            >
              <MdCreateNewFolder className="text-sm text-gray-500" /> New subcollection
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,video/*"
              className="hidden"
              onChange={(e) => {
                const selected = Array.from(e.target.files ?? [])
                if (selected.length > 0) setPendingFiles(selected)
                e.target.value = ''
              }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
            >
              <MdUploadFile className="text-sm" /> Upload
            </button>
          </>
        )}
      </div>

      {creating && (
        <div className="flex items-center gap-2 mb-4 px-2 py-1.5 rounded-lg bg-purple-50 ring-1 ring-purple-200 ring-inset max-w-sm">
          <MdPhotoLibrary className="text-purple-400 text-lg shrink-0" />
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newName.trim()) createSub.mutate(newName.trim())
              if (e.key === 'Escape') { setCreating(false); setNewName('') }
            }}
            placeholder="Subcollection name"
            className="flex-1 bg-transparent border-0 outline-none text-sm text-gray-800 placeholder-gray-400"
          />
          <button
            onClick={() => newName.trim() && createSub.mutate(newName.trim())}
            disabled={!newName.trim() || createSub.isPending}
            className="text-green-500 hover:text-green-700 disabled:opacity-30 cursor-pointer bg-transparent border-0 p-0.5"
          >
            <MdCheck className="text-lg" />
          </button>
          <button
            onClick={() => { setCreating(false); setNewName('') }}
            className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0.5"
          >
            <MdClose className="text-lg" />
          </button>
        </div>
      )}

      {/* Subcollections */}
      {subfolders.length > 0 && (
        <section className="mb-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Subcollections</h3>
          <div className="flex flex-wrap gap-2">
            {subfolders.map((sf) => (
              <button
                key={sf.id}
                onClick={() => onOpenFolder(sf.id)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 cursor-pointer transition-colors"
              >
                <MdPhotoLibrary className="text-purple-400 text-base" /> {sf.name}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Media grid */}
      {files.length === 0 ? (
        <p className="text-sm text-gray-400 mt-4">
          {hidden === 'only' ? 'No hidden media.' : 'No media in this collection yet.'}
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {files.map((f) => (
            <MediaTile
              key={f.id}
              file={f}
              readOnly={readOnly}
              subcollections={subfolders}
              isSubcollection={isSubcollection}
              onOpen={() => onOpenFile(f.id)}
              onToggleHidden={() => hideMutation.mutate({ id: f.id, hide: !f.hidden })}
              onCopy={(collectionId) => copyMutation.mutate({ collectionId, fileId: f.id })}
              onRemove={() => removeMutation.mutate(f.id)}
            />
          ))}
        </div>
      )}

      {hasNextPage && (
        <button
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="mt-4 text-sm text-blue-600 hover:text-blue-700 cursor-pointer bg-transparent border-0 disabled:opacity-50"
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}

      {user && (
        <p className="text-xs text-gray-400 mt-6">Tip: enable auto-upload in your profile to send all photos and videos here.</p>
      )}

      {pendingFiles.length > 0 && user && !readOnly && (
        <UploadModal
          files={pendingFiles}
          folderName={folder.name}
          user={user}
          onConfirm={() => {
            const filesToUpload = pendingFiles
            setPendingFiles([])
            startUpload(filesToUpload, folderId, () => {
              invalidate()
              queryClient.invalidateQueries({ queryKey: ['me'] })
            })
          }}
          onCancel={() => setPendingFiles([])}
        />
      )}

      <UploadToast progress={progress} onDismiss={dismiss} />
    </div>
  )
}

function ToggleBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1.5 cursor-pointer border-0 transition-colors ${
        active ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
      }`}
    >
      {label}
    </button>
  )
}

function MediaTile({
  file,
  readOnly,
  subcollections,
  isSubcollection,
  onOpen,
  onToggleHidden,
  onCopy,
  onRemove,
}: {
  file: File
  readOnly: boolean
  subcollections: Folder[]
  isSubcollection: boolean
  onOpen: () => void
  onToggleHidden: () => void
  onCopy: (collectionId: string) => void
  onRemove: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const isImage = file.mime_type.startsWith('image/')
  const isVideo = file.mime_type.startsWith('video/')
  const dateLabel = file.taken_at ?? file.created_at

  return (
    <div className={`relative group rounded-lg overflow-hidden border border-gray-200 bg-gray-50 ${file.hidden ? 'opacity-60' : ''}`}>
      <button
        onClick={onOpen}
        className="block w-full aspect-square bg-gray-100 cursor-pointer border-0 p-0 m-0"
        title={file.name}
      >
        {isImage ? (
          <img src={previewUrl(file.id)} alt={file.name} loading="lazy" className="w-full h-full object-cover" />
        ) : (
          <span className="flex items-center justify-center w-full h-full text-gray-300">
            {isVideo ? <MdMovie className="text-4xl" /> : <MdInsertDriveFile className="text-4xl" />}
          </span>
        )}
      </button>

      <div className="px-2 py-1.5">
        <p className="text-xs text-gray-700 truncate m-0" title={file.name}>{file.name}</p>
        <p className="text-[10px] text-gray-400 m-0">
          {new Date(dateLabel).toLocaleDateString()}
          {file.taken_at ? '' : ' (uploaded)'}
        </p>
      </div>

      {file.hidden && (
        <span className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded">Hidden</span>
      )}

      {!readOnly && (
        <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onToggleHidden}
            title={file.hidden ? 'Unhide' : 'Hide'}
            className="bg-white/90 hover:bg-white rounded p-1 cursor-pointer border-0 text-gray-600 shadow-sm"
          >
            {file.hidden ? <MdVisibility className="text-sm" /> : <MdVisibilityOff className="text-sm" />}
          </button>
          {subcollections.length > 0 && (
            <button
              onClick={() => setMenuOpen((v) => !v)}
              title="Add to subcollection"
              className="bg-white/90 hover:bg-white rounded p-1 cursor-pointer border-0 text-gray-600 shadow-sm"
            >
              <MdAdd className="text-sm" />
            </button>
          )}
        </div>
      )}

      {menuOpen && subcollections.length > 0 && (
        <div className="absolute top-9 right-1 z-10 bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-40">
          <p className="text-[10px] text-gray-400 uppercase tracking-wide px-3 py-1">Copy to</p>
          {subcollections.map((sf) => (
            <button
              key={sf.id}
              onClick={() => { onCopy(sf.id); setMenuOpen(false) }}
              className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer border-0 bg-transparent"
            >
              {sf.name}
            </button>
          ))}
          {isSubcollection && (
            <button
              onClick={() => { onRemove(); setMenuOpen(false) }}
              className="block w-full text-left px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 cursor-pointer border-0 bg-transparent border-t border-gray-100"
            >
              Remove from this collection
            </button>
          )}
        </div>
      )}
    </div>
  )
}
