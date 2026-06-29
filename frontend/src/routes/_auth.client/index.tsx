import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import {
  MdArrowBack,
  MdCheck,
  MdCloudQueue,
  MdCloudUpload,
  MdClose,
  MdCreateNewFolder,
  MdFolder,
  MdFolderOpen,
  MdInsertDriveFile,
  MdLink,
  MdPhotoLibrary,
  MdStar,
  MdStarOutline,
  MdUploadFile,
} from 'react-icons/md'
import { createFolder, deleteFolder, moveFolder, getAncestors } from '../../api/folders'
import { deleteFile, downloadUrl, fileQueryOptions, moveFile } from '../../api/files'
import { meQueryOptions, preferencesQueryOptions, updatePreferences } from '../../api/me'
import { useNotification } from '../../context/NotificationContext'
import { FilePreviewModal, canPreview } from '../../components/FilePreviewModal'
import { MediaCollectionView } from '../../components/MediaCollectionView'
import type { FolderKind } from '../../types/api'
import { UploadModal } from '../../components/UploadModal'
import { DeleteConfirmModal, readSkipDeleteCookie } from '../../components/DeleteConfirmModal'
import { FolderBreadcrumb } from '../../components/FolderBreadcrumb'
import { ShareDirectoryModal } from '../../components/ShareDirectoryModal'
import { UploadToast } from '../../components/UploadToast'
import { SortControls } from '../../components/SortControls'
import { SearchBar } from '../../components/SearchBar'
import { useFileUpload } from '../../hooks/useFileUpload'
import { useDragDrop } from '../../hooks/useDragDrop'
import { useFileDrag } from '../../hooks/useFileDrag'
import { useSort, sortedFolders, sortedFiles } from '../../hooks/useSort'
import { useInfiniteFolderContents } from '../../hooks/useInfiniteFolderContents'
import { useFavorites } from '../../hooks/useFavorites'
import { useImpersonation } from '../../context/ImpersonationContext'
import { GoogleServiceSelectModal } from '../../components/GoogleServiceSelectModal'
import { GoogleBackupModal } from '../../components/GoogleBackupModal'
import type { GoogleServiceSelection } from '../../components/GoogleServiceSelectModal'
import {
  requestGoogleAccessToken,
  listGoogleDriveFiles,
  pickGooglePhotosWeb,
  uploadGoogleEntries,
  type BackupEntry,
  type GoogleBackupItem,
} from '../../api/googleBackup'

export const Route = createFileRoute('/_auth/client/')({
  validateSearch: (search: Record<string, unknown>) => ({
    file: typeof search.file === 'string' ? search.file : undefined,
    folder: typeof search.folder === 'string' ? search.folder : undefined,
  }),
  component: RouteComponent,
})

function RouteComponent() {
  const { file: fileId, folder: folderId } = useSearch({ from: '/_auth/client/' })

  if (fileId) return <FileView fileId={fileId} />
  return <FolderView folderId={folderId ?? 'root'} />
}

// ── File view ─────────────────────────────────────────────────────────────────

function FileView({ fileId }: { fileId: string }) {
  const navigate = useNavigate()
  const { folder: currentFolder } = useSearch({ from: '/_auth/client/' })
  const { data: file, isLoading, error } = useQuery(fileQueryOptions(fileId))

  function close() {
    navigate({ to: '/client', search: { file: undefined, folder: currentFolder } })
  }

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (error || !file) return (
    <div>
      <BackButton onClick={close} />
      <p className="text-sm text-gray-500 mt-4">File not found.</p>
    </div>
  )

  if (canPreview(file.mime_type)) {
    return <FilePreviewModal file={file} onClose={close} />
  }

  return (
    <div className="flex flex-col items-center py-16 gap-3">
      <MdInsertDriveFile className="text-7xl text-gray-300" />
      <h2 className="text-lg font-semibold text-gray-900 m-0">{file.name}</h2>
      <span className="text-sm text-gray-400">{formatSize(file.size_bytes)}</span>
      <div className="flex gap-3 mt-2">
        <a
          href={downloadUrl(fileId)}
          className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg no-underline transition-colors"
        >
          Download
        </a>
        <button
          onClick={close}
          className="px-5 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 cursor-pointer transition-colors"
        >
          Back
        </button>
      </div>
    </div>
  )
}

// ── Folder view ───────────────────────────────────────────────────────────────

function FolderView({ folderId }: { folderId: string | 'root' }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const { data: user } = useQuery(meQueryOptions)
  const { impersonatedUser } = useImpersonation()
  const readOnly = impersonatedUser !== null
  const fileRef = useRef<HTMLInputElement>(null)
  const [pendingFiles, setPendingFiles] = useState<globalThis.File[]>([])
  const [pendingDelete, setPendingDelete] = useState<{ type: 'file' | 'folder'; id: string; name: string } | null>(null)
  const [sharingFolder, setSharingFolder] = useState<{ id: string; name: string } | null>(null)
  const [search, setSearch] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderKind, setNewFolderKind] = useState<FolderKind>('regular')
  const { progress, startUpload, dismiss } = useFileUpload()
  const { isDragging } = useDragDrop((dropped) => { if (!readOnly) setPendingFiles(dropped) })
  const { sort, onSort } = useSort()
  const { favoriteFileIds, favoriteFolderIds, toggleFile, toggleFolder } = useFavorites()
  const { data: prefs } = useQuery(preferencesQueryOptions)
  const autoUploadTargetId = prefs?.media_autoupload_folder_id ?? null

  // ── Google Backup state ────────────────────────────────────────────────────
  const [serviceSelectOpen, setServiceSelectOpen]   = useState(false)
  const [googleLoading, setGoogleLoading]           = useState(false)
  const [googleError, setGoogleError]               = useState<string | null>(null)
  const [googleAccessToken, setGoogleAccessToken]   = useState('')
  const [googleBackupItems, setGoogleBackupItems]   = useState<GoogleBackupItem[] | null>(null)
  const [bgBackupState, setBgBackupState] = useState<{
    running: boolean; done: number; total: number
    uploaded: number; duplicates: number; errors: number
    driveIds: string[]
  } | null>(null)

  const {
    folder,
    folders: rawSubfolders,
    files: rawFiles,
    isLoading,
    error,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteFolderContents(folderId, search, impersonatedUser?.username)

  const moveFileMutation = useMutation({
    mutationFn: ({ fileId, targetFolderId }: { fileId: string; targetFolderId: string }) =>
      moveFile(fileId, targetFolderId),
    onSuccess: (_, { targetFolderId }) => {
      queryClient.invalidateQueries({ queryKey: ['folders'] })
      navigate({ to: '/client', search: { file: undefined, folder: targetFolderId } })
    },
  })

  const moveFolderMutation = useMutation({
    mutationFn: ({ folderId, targetFolderId }: { folderId: string; targetFolderId: string }) =>
      moveFolder(folderId, targetFolderId),
    onSuccess: (_, { targetFolderId }) => {
      queryClient.invalidateQueries({ queryKey: ['folders'] })
      navigate({ to: '/client', search: { file: undefined, folder: targetFolderId } })
    },
  })

  const { draggingFileId, draggingFolderId, dragOverFolderId, getFileDragHandlers, getFolderDragHandlers, getFolderDropHandlers } =
    useFileDrag(
      (fileId, targetFolderId) => moveFileMutation.mutate({ fileId, targetFolderId }),
      (folderId, targetFolderId) => moveFolderMutation.mutate({ folderId, targetFolderId }),
    )

  const setAutoUploadMutation = useMutation({
    mutationFn: (folderId: string | null) => updatePreferences(folderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['preferences'] })
    },
    onError: () => notify('error', 'Failed to update auto-upload target'),
  })

  function toggleAutoUploadTarget(folderId: string) {
    setAutoUploadMutation.mutate(autoUploadTargetId === folderId ? null : folderId)
  }

  const createFolderMutation = useMutation({
    mutationFn: ({ name, kind }: { name: string; kind: FolderKind }) =>
      createFolder(name, folderId === 'root' ? undefined : folderId, kind),
    onSuccess: (folder) => {
      setCreatingFolder(false)
      setNewFolderName('')
      setNewFolderKind('regular')
      queryClient.invalidateQueries({ queryKey: ['folders', folderId] })
      // A newly created media collection becomes the user's auto-upload target.
      if (folder.kind === 'media') {
        setAutoUploadMutation.mutate(folder.id)
        notify('success', `"${folder.name}" is now your auto-upload destination`)
      }
    },
    onError: () => notify('error', 'Failed to create folder'),
  })

  function startCreate(kind: FolderKind) {
    setNewFolderKind(kind)
    setNewFolderName('')
    setCreatingFolder(true)
  }

  function confirmNewFolder() {
    const name = newFolderName.trim()
    if (name) createFolderMutation.mutate({ name, kind: newFolderKind })
  }

  function cancelNewFolder() {
    setCreatingFolder(false)
    setNewFolderName('')
    setNewFolderKind('regular')
  }

  const deleteFolderMutation = useMutation({
    mutationFn: deleteFolder,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folders'] })
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
    onError: () => notify('error', 'Failed to delete folder'),
  })

  const deleteFileMutation = useMutation({
    mutationFn: deleteFile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folders', folderId] })
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
    onError: () => notify('error', 'Failed to delete file'),
  })

  function handleDeleteClick(type: 'file' | 'folder', id: string, name: string) {
    if (user && readSkipDeleteCookie(user.username)) {
      if (type === 'file') deleteFileMutation.mutate(id)
      else deleteFolderMutation.mutate(id)
    } else {
      setPendingDelete({ type, id, name })
    }
  }

  function openFolder(id: string) {
    navigate({ to: '/client', search: { file: undefined, folder: id } })
  }

  function openFile(id: string) {
    navigate({ to: '/client', search: { file: id, folder: folderId === 'root' ? undefined : folderId } })
  }

  function goBack() {
    if (folderId === 'root') return
    navigate({ to: '/client', search: { file: undefined, folder: folder?.parent_id ?? undefined } })
  }

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (error) return <p className="text-sm text-red-500">Failed to load files.</p>

  const isPremium = user?.is_premium || user?.is_admin
  const hasGoogleLinked = user?.linked_providers?.includes('google') ?? false
  const showGoogleBackup = !readOnly && isPremium && hasGoogleLinked

  // ── Google Backup handlers ─────────────────────────────────────────────────

  async function handleGoogleServiceContinue(selection: GoogleServiceSelection) {
    setServiceSelectOpen(false)
    setGoogleLoading(true)
    setGoogleError(null)
    try {
      const token = await requestGoogleAccessToken()
      setGoogleAccessToken(token)
      const driveItems = selection.drive  ? await listGoogleDriveFiles(token)    : []
      const photoItems = selection.photos ? await pickGooglePhotosWeb(token)      : []
      const all = [...driveItems, ...photoItems]
      if (all.length === 0) {
        setGoogleError('No files were found or selected.')
        return
      }
      setGoogleBackupItems(all)
    } catch (e: any) {
      // GIS popup closed by user has no stable error code — swallow silently
      const msg = e?.message ?? ''
      if (msg && !msg.toLowerCase().includes('popup') && !msg.toLowerCase().includes('cancel')) {
        setGoogleError(msg)
      }
    } finally {
      setGoogleLoading(false)
    }
  }

  function handleStartBackground(entries: BackupEntry[], token: string) {
    setGoogleBackupItems(null)
    const driveIds = entries.filter((e) => e.googleItem.source === 'drive').map((e) => e.googleItem.id)
    setBgBackupState({ running: true, done: 0, total: entries.length, uploaded: 0, duplicates: 0, errors: 0, driveIds })
    uploadGoogleEntries(entries, token, (done, total) =>
      setBgBackupState((s) => (s ? { ...s, done, total } : s)),
    ).then(({ uploaded, duplicates, errors }) => {
      setBgBackupState((s) => (s ? { ...s, running: false, uploaded, duplicates, errors } : s))
      queryClient.invalidateQueries({ queryKey: ['folders', folderId] })
      queryClient.invalidateQueries({ queryKey: ['me'] })
    })
  }

  // Media collections render as a date-sorted gallery with hidden/subcollection
  // controls instead of the standard file/folder listing.
  if (folder && folder.kind === 'media') {
    if (!isPremium) {
      return (
        <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
          <MdPhotoLibrary className="text-6xl text-purple-300" />
          <h2 className="text-lg font-semibold text-gray-900 m-0">Media Collections</h2>
          <p className="text-sm text-gray-500 max-w-xs">
            Media collections are a premium feature. Upgrade to access photo and video galleries.
          </p>
          <a
            href="/premium"
            className="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-600 text-white rounded-lg font-medium transition-colors"
          >
            Upgrade to Premium
          </a>
          <button onClick={goBack} className="text-sm text-gray-500 hover:text-gray-700 bg-transparent border-0 cursor-pointer">
            Go back
          </button>
        </div>
      )
    }
    return (
      <MediaCollectionView
        folderId={folder.id}
        folder={folder}
        readOnly={readOnly}
        onBack={goBack}
        onOpenFolder={openFolder}
        onOpenFile={openFile}
      />
    )
  }

  const subfolders = sortedFolders(rawSubfolders, sort)
  const files = sortedFiles(rawFiles, sort)
  // null = root upload (no folder); backend accepts absent folder_id for root.
  const uploadFolderId: string | null = folderId === 'root' ? null : folderId
  const hasContent = rawSubfolders.length > 0 || rawFiles.length > 0
  const noResults = search && !isLoading && !hasNextPage && !hasContent
  const viewingUser = impersonatedUser ?? user

  return (
    <div>
      {folderId !== 'root' ? (
        <div className="mb-2">
          <FolderBreadcrumb
            folderId={folderId}
            onNavigate={(id) => navigate({ to: '/client', search: { file: undefined, folder: id } })}
            trailing={
              !readOnly && (user?.is_premium || user?.is_admin) && folder ? (
                <ShareButton onOpen={() => setSharingFolder({ id: folder.id, name: folder.name })} />
              ) : undefined
            }
          />
          {folder && <h2 className="text-lg font-semibold text-gray-900 m-0">{folder.name}</h2>}
        </div>
      ) : (
        <div className="flex items-center gap-3 mb-5">
          <h2 className="text-lg font-semibold text-gray-900 mt-0 mb-0">
            {readOnly ? `${impersonatedUser!.username}'s Files` : 'My Files'}
          </h2>
          {user?.is_premium && !user?.is_admin && (
            <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-amber-100 text-amber-700 rounded">
              Premium
            </span>
          )}
        </div>
      )}

      {!readOnly && (
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => startCreate('regular')}
            disabled={creatingFolder}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 cursor-pointer transition-colors disabled:opacity-40"
          >
            <MdCreateNewFolder className="text-base text-gray-500" /> New folder
          </button>
          {isPremium && (
            <button
              onClick={() => startCreate('media')}
              disabled={creatingFolder}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 cursor-pointer transition-colors disabled:opacity-40"
            >
              <MdPhotoLibrary className="text-base text-purple-400" /> New collection
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const selected = Array.from(e.target.files ?? [])
              if (selected.length > 0) setPendingFiles(selected)
              e.target.value = ''
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
          >
            <MdUploadFile className="text-base" /> Upload
          </button>
          {showGoogleBackup && (
            <button
              onClick={() => { setGoogleError(null); setServiceSelectOpen(true) }}
              disabled={googleLoading || bgBackupState?.running}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-white hover:bg-gray-50 text-gray-700 rounded-lg font-medium cursor-pointer border border-gray-200 transition-colors disabled:opacity-50"
            >
              {googleLoading ? (
                <div className="w-3.5 h-3.5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
              ) : (
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" aria-hidden="true">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
              )}
              Google Backup
            </button>
          )}
        </div>
      )}

      {viewingUser && (
        <QuotaBar used={viewingUser.storage_used_bytes} quota={viewingUser.storage_quota_bytes} />
      )}

      {/* Google Backup error */}
      {googleError && (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-600">
          <span className="flex-1">{googleError}</span>
          <button onClick={() => setGoogleError(null)} className="text-red-400 hover:text-red-600 cursor-pointer"><MdClose /></button>
        </div>
      )}

      {/* Background Google Backup progress card */}
      {bgBackupState && (
        <div className="mb-3 px-3 py-2.5 bg-white border border-gray-200 rounded-lg shadow-sm flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0" aria-hidden="true">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              <span className="text-xs font-semibold text-gray-700">
                {bgBackupState.running ? 'Backing up from Google…' : 'Google Backup complete'}
              </span>
            </div>
            {!bgBackupState.running && (
              <button onClick={() => setBgBackupState(null)} className="text-gray-400 hover:text-gray-600 cursor-pointer"><MdClose className="text-sm" /></button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${bgBackupState.running ? 'bg-blue-500' : bgBackupState.errors > 0 ? 'bg-amber-500' : 'bg-green-500'}`}
                style={{ width: `${bgBackupState.total > 0 ? Math.round((bgBackupState.done / bgBackupState.total) * 100) : 0}%` }}
              />
            </div>
            <span className="text-xs text-gray-500 shrink-0">{bgBackupState.done}/{bgBackupState.total}</span>
          </div>
          {!bgBackupState.running && (
            <p className={`text-xs ${bgBackupState.errors > 0 ? 'text-amber-600' : 'text-green-600'}`}>
              {[
                `${bgBackupState.uploaded} backed up`,
                bgBackupState.duplicates > 0 ? `${bgBackupState.duplicates} duplicate${bgBackupState.duplicates !== 1 ? 's' : ''}` : null,
                bgBackupState.errors > 0 ? `${bgBackupState.errors} failed` : null,
              ].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      )}

      <SearchBar value={search} onChange={setSearch} />

      {!search && !hasContent && (
        <p className="text-sm text-gray-400 mt-4">
          {folderId === 'root' ? 'No files yet. Upload something to get started.' : 'This folder is empty.'}
        </p>
      )}
      {noResults && <p className="text-sm text-gray-400">No results for &ldquo;{search}&rdquo;.</p>}

      {hasContent && <SortControls sort={sort} onSort={onSort} />}

      {(creatingFolder || subfolders.length > 0) && (
        <section className="mb-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Folders</h3>
          <ul className="list-none m-0 p-0">
            {creatingFolder && (
              <li className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-blue-50 ring-1 ring-blue-200 ring-inset mb-1">
                {newFolderKind === 'media'
                  ? <MdPhotoLibrary className="text-purple-400 text-lg shrink-0" />
                  : <MdFolder className="text-blue-400 text-lg shrink-0" />}
                <input
                  autoFocus
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmNewFolder()
                    if (e.key === 'Escape') cancelNewFolder()
                  }}
                  placeholder={newFolderKind === 'media' ? 'Collection name' : 'Folder name'}
                  className="flex-1 bg-transparent border-0 outline-none text-sm text-gray-800 placeholder-gray-400"
                />
                <button
                  onClick={confirmNewFolder}
                  disabled={!newFolderName.trim() || createFolderMutation.isPending}
                  title="Create folder"
                  className="text-green-500 hover:text-green-700 disabled:opacity-30 cursor-pointer bg-transparent border-0 p-0.5 transition-colors"
                >
                  <MdCheck className="text-lg" />
                </button>
                <button
                  onClick={cancelNewFolder}
                  title="Cancel"
                  className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0.5 transition-colors"
                >
                  <MdClose className="text-lg" />
                </button>
              </li>
            )}
            {subfolders.map((f) => (
              <li
                key={f.id}
                {...(!readOnly ? getFolderDragHandlers(f) : {})}
                {...(!readOnly ? getFolderDropHandlers(f) : {})}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors ${
                  !readOnly ? 'cursor-grab' : ''
                } ${
                  dragOverFolderId === f.id
                    ? 'bg-blue-50 ring-2 ring-blue-300 ring-inset'
                    : 'hover:bg-gray-50'
                } ${draggingFolderId === f.id ? 'opacity-40' : ''}`}
              >
                <button
                  onClick={() => openFolder(f.id)}
                  className="flex-1 flex items-center gap-2 bg-transparent border-0 cursor-pointer text-left text-sm text-gray-800 hover:text-gray-900 p-0 min-w-0"
                >
                  {f.kind === 'media'
                    ? <MdPhotoLibrary className="text-purple-400 text-lg shrink-0" />
                    : <MdFolder className="text-blue-400 text-lg shrink-0" />}
                  <span className="truncate">{f.name}</span>
                </button>
                <span className="text-xs text-gray-400 shrink-0 hidden sm:inline">
                  {new Date(f.created_at).toLocaleDateString()}
                </span>
                <span className="text-xs text-gray-400 shrink-0">{formatSize(f.size_bytes)}</span>
                {!readOnly && (
                  <>
                    {f.kind === 'media' && (
                      <AutoUploadButton
                        active={autoUploadTargetId === f.id}
                        onClick={() => toggleAutoUploadTarget(f.id)}
                      />
                    )}
                    <StarButton active={favoriteFolderIds.has(f.id)} onClick={() => toggleFolder(f.id)} title={favoriteFolderIds.has(f.id) ? 'Remove from favorites' : 'Add to favorites'} />
                    {(user?.is_premium || user?.is_admin) && (
                      <button
                        onClick={() => setSharingFolder({ id: f.id, name: f.name })}
                        title="Share via SFS API"
                        className="text-amber-400 hover:text-amber-600 cursor-pointer bg-transparent border-0 p-0.5 transition-colors"
                      >
                        <MdLink className="text-base" />
                      </button>
                    )}
                    <button
                      onClick={() => handleDeleteClick('folder', f.id, f.name)}
                      className="text-xs text-gray-400 hover:text-red-500 cursor-pointer bg-transparent border-0 px-1 transition-colors"
                    >
                      Delete
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {files.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Files</h3>
          <ul className="list-none m-0 p-0">
            {files.map((f) => (
              <li
                key={f.id}
                {...(!readOnly ? getFileDragHandlers(f) : {})}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 transition-colors ${!readOnly ? 'cursor-grab' : ''} ${draggingFileId === f.id ? 'opacity-40' : ''}`}
              >
                <button
                  onClick={() => openFile(f.id)}
                  className="flex-1 flex items-center gap-2 bg-transparent border-0 cursor-pointer text-left text-sm text-gray-800 hover:text-gray-900 p-0 min-w-0"
                >
                  <MdInsertDriveFile className="text-gray-400 text-lg shrink-0" />
                  <span className="truncate">{f.name}</span>
                </button>
                <span className="text-xs text-gray-400 shrink-0 hidden sm:inline">
                  {new Date(f.created_at).toLocaleDateString()}
                </span>
                <span className="text-xs text-gray-400 shrink-0">{formatSize(f.size_bytes)}</span>
                {!readOnly && (
                  <>
                    <StarButton active={favoriteFileIds.has(f.id)} onClick={() => toggleFile(f.id)} title={favoriteFileIds.has(f.id) ? 'Remove from favorites' : 'Add to favorites'} />
                    <button
                      onClick={() => handleDeleteClick('file', f.id, f.name)}
                      className="text-xs text-gray-400 hover:text-red-500 cursor-pointer bg-transparent border-0 px-1 transition-colors"
                    >
                      Delete
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
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

      {pendingFiles.length > 0 && user && !readOnly && (
        <UploadModal
          files={pendingFiles}
          folderName={folderId === 'root' ? 'My Files' : (folder?.name ?? 'This folder')}
          user={user}
          onConfirm={() => {
            const filesToUpload = pendingFiles
            setPendingFiles([])
            startUpload(filesToUpload, uploadFolderId, () => {
              queryClient.invalidateQueries({ queryKey: ['folders', folderId] })
              queryClient.invalidateQueries({ queryKey: ['me'] })
            })
          }}
          onCancel={() => setPendingFiles([])}
        />
      )}

      <UploadToast progress={progress} onDismiss={dismiss} />

      {/* Google Backup — service selection */}
      {serviceSelectOpen && (
        <GoogleServiceSelectModal
          onCancel={() => setServiceSelectOpen(false)}
          onContinue={handleGoogleServiceContinue}
        />
      )}

      {/* Google Backup — file picker + upload modal */}
      {googleBackupItems && user && (
        <GoogleBackupModal
          items={googleBackupItems}
          accessToken={googleAccessToken}
          quotaBytes={user.storage_quota_bytes}
          usedBytes={user.storage_used_bytes}
          redirectFolderName={
            autoUploadTargetId
              ? (subfolders.find((f) => f.id === autoUploadTargetId)?.name ?? null)
              : null
          }
          onClose={() => setGoogleBackupItems(null)}
          onDone={() => {
            setGoogleBackupItems(null)
            queryClient.invalidateQueries({ queryKey: ['folders', folderId] })
            queryClient.invalidateQueries({ queryKey: ['me'] })
          }}
          onStartBackground={handleStartBackground}
        />
      )}

      {pendingDelete && (
        <DeleteConfirmModal
          name={pendingDelete.name}
          username={user?.username ?? ''}
          onConfirm={() => {
            if (pendingDelete.type === 'file') deleteFileMutation.mutate(pendingDelete.id)
            else deleteFolderMutation.mutate(pendingDelete.id)
            setPendingDelete(null)
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {sharingFolder && (
        <SharedDirectoryGate
          folderId={sharingFolder.id}
          folderName={sharingFolder.name}
          onClose={() => setSharingFolder(null)}
        />
      )}

      {isDragging && !readOnly && (
        <div className="fixed inset-0 bg-blue-500/10 border-4 border-dashed border-blue-400 flex items-center justify-center z-999 pointer-events-none">
          <div className="bg-white/95 rounded-2xl px-12 py-6 text-center shadow-xl">
            <MdFolderOpen className="text-5xl text-blue-500 mx-auto mb-2" />
            <div className="text-lg font-semibold text-blue-600">Drop files to upload</div>
            <div className="text-sm text-gray-400 mt-1">
              to {folderId === 'root' ? 'My Files' : (folder?.name ?? 'this folder')}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Shared components ─────────────────────────────────────────────────────────

function QuotaBar({ used, quota }: { used: number; quota: number }) {
  const pct = quota > 0 ? (used / quota) * 100 : 0
  const color =
    pct >= 90 ? 'bg-red-500' :
    pct >= 50 ? 'bg-amber-400' :
                'bg-green-500'
  return (
    <div className="mb-4">
      <div className="flex justify-between text-xs text-gray-400 mb-1">
        <span>{formatSize(used)} used</span>
        <span>{formatSize(quota)} quota</span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 cursor-pointer bg-transparent border-0 p-0 transition-colors"
    >
      <MdArrowBack className="text-base" /> Back
    </button>
  )
}

function StarButton({ active, onClick, title }: { active: boolean; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`cursor-pointer bg-transparent border-0 p-0.5 transition-colors ${active ? 'text-amber-400 hover:text-amber-500' : 'text-gray-300 hover:text-amber-400'}`}
    >
      {active ? <MdStar className="text-lg" /> : <MdStarOutline className="text-lg" />}
    </button>
  )
}

// AutoUploadButton marks a media collection as the destination that incoming
// photos and videos are routed to. Only one collection can be the target at a
// time, so clicking the active button clears it (handled by the parent toggle).
function AutoUploadButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={active ? 'Auto-upload destination — click to disable' : 'Set as auto-upload destination'}
      className={`cursor-pointer bg-transparent border-0 p-0.5 transition-colors ${active ? 'text-sky-500 hover:text-sky-600' : 'text-gray-300 hover:text-sky-400'}`}
    >
      {active ? <MdCloudUpload className="text-lg" /> : <MdCloudQueue className="text-lg" />}
    </button>
  )
}

function ShareButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      title="Share via SFS API"
      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-amber-200 text-amber-700 bg-amber-50 hover:bg-amber-100 cursor-pointer transition-colors"
    >
      <MdLink className="text-sm" /> Share
    </button>
  )
}

// SharedDirectoryGate looks up the ancestor chain for the folder being
// shared so the modal can render the SFS path string before opening.
// Without the ancestors we can't build the slash-joined key.
function SharedDirectoryGate({
  folderId, folderName, onClose,
}: { folderId: string; folderName: string; onClose: () => void }) {
  const [path, setPath] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    getAncestors(folderId)
      .then((res) => {
        if (cancelled) return
        const joined = res.ancestors.map((a) => a.name).join('/')
        setPath(joined)
      })
      .catch(() => { if (!cancelled) setPath('') })
    return () => { cancelled = true }
  }, [folderId])
  if (path === null) return null
  return <ShareDirectoryModal path={path} folderName={folderName} onClose={onClose} />
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
