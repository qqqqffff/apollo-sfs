import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import {
  MdAddCircleOutline,
  MdArrowBack,
  MdBolt,
  MdCheck,
  MdCloudQueue,
  MdCloudUpload,
  MdClose,
  MdDeleteOutline,
  MdFolder,
  MdFolderOpen,
  MdInfoOutline,
  MdInsertDriveFile,
  MdPhotoLibrary,
  MdShare,
  MdStar,
  MdStarOutline,
  MdStorage,
  MdUploadFile,
  MdVisibility,
} from 'react-icons/md'
import { createFolder, deleteFolder, moveFolder, requestDriveMigration } from '../../api/folders'
import { deleteFile, downloadUrl, fileQueryOptions, moveFile } from '../../api/files'
import { meQueryOptions, preferencesQueryOptions, updatePreferences } from '../../api/me'
import { listMyServers, resolveDrive, type MyServer } from '../../api/storage'
import { infrastructureQueryOptions, type DriveSummary } from '../../api/admin'
import { ApiError } from '../../api/client'
import { useNotification } from '../../context/NotificationContext'
import { FilePreviewModal, canPreview } from '../../components/FilePreviewModal'
import { MediaCollectionView } from '../../components/MediaCollectionView'
import type { Folder, FolderKind } from '../../types/api'
import { UploadModal } from '../../components/UploadModal'
import { StorageUpgradeModal, STORAGE_PROMPT_THRESHOLD } from '../../components/StorageUpgradeModal'
import { ShareModal } from '../../components/ShareModal'
import { DeleteConfirmModal, readSkipDeleteCookie } from '../../components/DeleteConfirmModal'
import { FolderBreadcrumb } from '../../components/FolderBreadcrumb'
import { GroupBadge, groupOf } from '../../components/GroupBadge'
import { TierIcon } from '../../components/TierIcon'
import { UploadToast } from '../../components/UploadToast'
import { SortControls } from '../../components/SortControls'
import { SearchBar } from '../../components/SearchBar'
import { useFileUpload } from '../../hooks/useFileUpload'
import { useDragDrop } from '../../hooks/useDragDrop'
import { useFileDrag } from '../../hooks/useFileDrag'
import { useSort, sortedFolders, sortedFiles } from '../../hooks/useSort'
import { useInfiniteFolderContents } from '../../hooks/useInfiniteFolderContents'
import { useFavorites } from '../../hooks/useFavorites'
import { useDriveMigrationProgress } from '../../hooks/useDriveMigrationProgress'
import { useImpersonation } from '../../context/ImpersonationContext'
import { FilesLayout, parseFilesAction, type FilesAction } from '../../components/FilesSidebar'
import { GoogleServiceSelectModal } from '../../components/GoogleServiceSelectModal'
import { GoogleBackupModal } from '../../components/GoogleBackupModal'
import { GooglePhotosLoadingModal } from '../../components/GooglePhotosLoadingModal'
import type { GoogleServiceSelection } from '../../components/GoogleServiceSelectModal'
import {
  requestGoogleAccessToken,
  getGoogleUserEmail,
  listGoogleDriveFiles,
  pickGooglePhotosWeb,
  uploadGoogleEntries,
  type BackupEntry,
  type GoogleBackupItem,
} from '../../api/googleBackup'

export const Route = createFileRoute('/_auth/client/')({
  // All keys optional so navigations to /client elsewhere need not pass every
  // one. Only keys with a concrete value are included.
  validateSearch: (search: Record<string, unknown>): { file?: string; folder?: string; action?: FilesAction } => {
    const out: { file?: string; folder?: string; action?: FilesAction } = {}
    if (typeof search.file === 'string') out.file = search.file
    if (typeof search.folder === 'string') out.folder = search.folder
    const action = parseFilesAction(search.action)
    if (action) out.action = action
    return out
  },
  component: RouteComponent,
})

function RouteComponent() {
  const { file: fileId, folder: folderId } = useSearch({ from: '/_auth/client/' })

  return (
    <FilesLayout>
      {fileId ? <FileView fileId={fileId} /> : <FolderView folderId={folderId ?? 'root'} />}
    </FilesLayout>
  )
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
  const { action: sidebarAction } = useSearch({ from: '/_auth/client/' })
  const { impersonatedUser } = useImpersonation()
  const readOnly = impersonatedUser !== null
  const isPremium = user?.is_premium || user?.is_admin
  const fileRef = useRef<HTMLInputElement>(null)
  const [pendingFiles, setPendingFiles] = useState<globalThis.File[]>([])
  const [pendingDelete, setPendingDelete] = useState<{ type: 'file' | 'folder'; id: string; name: string } | null>(null)
  const [pendingShare, setPendingShare] = useState<{ type: 'file' | 'folder'; id: string; name: string } | null>(null)
  const [search, setSearch] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderKind, setNewFolderKind] = useState<FolderKind>('regular')
  const [newFolderDriveId, setNewFolderDriveId] = useState<string | null>(null)
  const { progress, startUpload, dismiss } = useFileUpload()
  const { isDragging } = useDragDrop((dropped) => { if (!readOnly) setPendingFiles(dropped) })

  // Auto-open the storage upgrade modal when a pending upload would exceed the
  // quota or push usage past 75% of it (unless disabled in preferences).
  useEffect(() => {
    if (!storagePromptEnabled || readOnly || !user || pendingFiles.length === 0) return
    const totalBytes = pendingFiles.reduce((sum, f) => sum + f.size, 0)
    const after = user.storage_used_bytes + totalBytes
    if (after > user.storage_quota_bytes) {
      setStorageModalReason('upload-over-quota')
    } else if (user.storage_quota_bytes > 0 && after >= user.storage_quota_bytes * STORAGE_PROMPT_THRESHOLD) {
      setStorageModalReason('upload-near-quota')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFiles])
  const { sort, onSort } = useSort()
  const { favoriteFileIds, favoriteFolderIds, toggleFile, toggleFolder } = useFavorites()
  const { data: prefs } = useQuery(preferencesQueryOptions)
  const autoUploadTargetId = prefs?.media_autoupload_folder_id ?? null
  const showStorageButtons = prefs?.show_storage_buttons ?? true
  const storagePromptEnabled = prefs?.storage_prompt_enabled ?? true
  const [storageModalReason, setStorageModalReason] =
    useState<'open' | 'upload-near-quota' | 'upload-over-quota' | null>(null)
  const { data: myServers } = useQuery({
    queryKey: ['storage', 'my-servers'],
    queryFn: listMyServers,
  })

  // ── Google Backup state ────────────────────────────────────────────────────
  const [serviceSelectOpen, setServiceSelectOpen]   = useState(false)
  const [googleLoading, setGoogleLoading]           = useState(false)
  const [googleLoadingMsg, setGoogleLoadingMsg]     = useState('Selecting photos to upload')
  const [googleError, setGoogleError]               = useState<string | null>(null)
  const [googleAccessToken, setGoogleAccessToken]   = useState('')
  const [googleBackupItems, setGoogleBackupItems]   = useState<GoogleBackupItem[] | null>(null)
  const googleCancelRef = useRef<(() => void) | null>(null)
  const [bgBackupState, setBgBackupState] = useState<{
    running: boolean; done: number; total: number
    uploaded: number; duplicates: number; errors: number
    driveIds: string[]
  } | null>(null)

  // Trigger the action requested from the side control panel (?action=…), then
  // strip the param so refreshes/back-navigation don't re-trigger it. Waits for
  // the user profile so premium gating is decided on real data.
  useEffect(() => {
    if (!sidebarAction || !user) return
    navigate({
      to: '/client',
      search: { file: undefined, folder: folderId === 'root' ? undefined : folderId, action: undefined },
      replace: true,
    })
    if (readOnly) return
    if (sidebarAction === 'new-folder') startCreate('regular')
    else if (sidebarAction === 'new-collection' && isPremium) startCreate('media')
    else if (sidebarAction === 'google-backup' && isPremium && (user.linked_providers?.includes('google') ?? false)) {
      setGoogleError(null)
      setServiceSelectOpen(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarAction, user])

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
    mutationFn: ({ name, kind, driveId }: { name: string; kind: FolderKind; driveId: string | null }) =>
      createFolder(name, folderId === 'root' ? undefined : folderId, kind, driveId ?? undefined),
    onSuccess: (folder) => {
      setCreatingFolder(false)
      setNewFolderName('')
      setNewFolderKind('regular')
      setNewFolderDriveId(null)
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
    const primary = myServers?.find((s) => s.is_primary)
    setNewFolderDriveId(primary?.drive_id ?? null)
    setCreatingFolder(true)
  }

  function confirmNewFolder() {
    const name = newFolderName.trim()
    if (name) createFolderMutation.mutate({ name, kind: newFolderKind, driveId: newFolderDriveId })
  }

  function cancelNewFolder() {
    setCreatingFolder(false)
    setNewFolderName('')
    setNewFolderKind('regular')
    setNewFolderDriveId(null)
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

  const hasGoogleLinked = user?.linked_providers?.includes('google') ?? false
  const showGoogleBackup = !readOnly && isPremium && hasGoogleLinked

  // ── Google Backup handlers ─────────────────────────────────────────────────

  async function handleGoogleServiceContinue(selection: GoogleServiceSelection) {
    setServiceSelectOpen(false)
    setGoogleLoadingMsg(
      selection.photos && !selection.drive ? 'Selecting photos to upload'
      : selection.photos                    ? 'Selecting files & photos to upload'
      :                                       'Loading your Drive files',
    )
    setGoogleLoading(true)
    setGoogleError(null)

    let cancelled = false
    // Pre-open the Photos popup synchronously before any awaits. Browsers block
    // window.open once the user gesture has been consumed by a prior await.
    let photosPopup: Window | null = null
    if (selection.photos) {
      // Open as a new tab (_blank, no features string) rather than a popup window.
      // Chrome almost never blocks tab opens from user gestures, whereas popup
      // windows (non-empty features string) are aggressively blocked.
      photosPopup = window.open('about:blank', '_blank')
    }

    googleCancelRef.current = () => {
      cancelled = true
      photosPopup?.close()
    }

    try {
      const token = await requestGoogleAccessToken()
      if (cancelled) return
      setGoogleAccessToken(token)
      // Pin the Photos picker to the account that just authorized (avoids the
      // multi-account "Couldn't add photos" failure). Best-effort; null is fine.
      const accountEmail = selection.photos ? await getGoogleUserEmail(token) : null
      if (cancelled) return
      const driveItems = selection.drive  ? await listGoogleDriveFiles(token) : []
      if (cancelled) return
      const photoItems = selection.photos
        ? await pickGooglePhotosWeb(token, photosPopup, () => cancelled, accountEmail)
        : []
      if (cancelled) return
      const all = [...driveItems, ...photoItems]
      if (all.length === 0) {
        setGoogleError('No files were found or selected.')
        return
      }
      setGoogleBackupItems(all)
    } catch (e: any) {
      if (cancelled) return
      const msg: string = e?.message ?? ''
      // Swallow silent dismissals (GIS popup closed, user cancelled)
      if (msg && !msg.toLowerCase().includes('popup_closed') && !msg.toLowerCase().includes('cancel')) {
        setGoogleError(msg)
      }
    } finally {
      googleCancelRef.current = null
      setGoogleLoading(false)
    }
  }

  function handleCancelGoogleLoading() {
    googleCancelRef.current?.()
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
  const { drive: uploadDrive, isPinned: uploadDriveIsPinned } = resolveDrive(
    folderId === 'root' ? null : (folder?.drive_id ?? null),
    myServers,
  )
  const hasContent = rawSubfolders.length > 0 || rawFiles.length > 0
  const noResults = search && !isLoading && !hasNextPage && !hasContent
  const viewingUser = impersonatedUser ?? user

  // Photos/videos get silently redirected server-side into the auto-upload
  // folder unless we're already uploading into a media collection — mirrors
  // FileService.resolveUploadFolder so the modal's lock icons match reality.
  const uploadRedirectFolderName =
    autoUploadTargetId && folder?.kind !== 'media'
      ? (subfolders.find((f) => f.id === autoUploadTargetId)?.name ?? null)
      : null

  return (
    <div>
      {folderId !== 'root' ? (
        <div className="mb-2">
          <FolderBreadcrumb
            folderId={folderId}
            onNavigate={(id) => navigate({ to: '/client', search: { file: undefined, folder: id } })}
          />
          {folder && <h2 className="text-lg font-semibold text-gray-900 m-0">{folder.name}</h2>}
        </div>
      ) : (
        <div className="flex items-center gap-3 mb-5">
          <h2 className="text-lg font-semibold text-gray-900 mt-0 mb-0">
            {readOnly ? `${impersonatedUser!.username}'s Files` : 'My Files'}
          </h2>
          {(user?.is_premium || user?.is_admin) && (
            <GroupBadge group={groupOf(user)} className="text-[10px]" />
          )}
        </div>
      )}

      {!readOnly && (
        <div className="flex gap-2 mb-4">
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
          {showGoogleBackup && googleLoading && (
            <button
              onClick={handleCancelGoogleLoading}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-white hover:bg-red-50 text-gray-500 hover:text-red-600 rounded-lg font-medium cursor-pointer border border-gray-200 transition-colors"
            >
              <div className="w-3.5 h-3.5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
              Cancel Google Backup
            </button>
          )}
        </div>
      )}

      {viewingUser && (
        <QuotaBar
          used={viewingUser.storage_used_bytes}
          quota={viewingUser.storage_quota_bytes}
          onAddStorage={!readOnly && showStorageButtons ? () => setStorageModalReason('open') : undefined}
        />
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
                {myServers && myServers.length > 0 && (() => {
                  const selected = myServers.find((s) => s.drive_id === newFolderDriveId)
                  const tier = selected?.drive_type ?? myServers.find((s) => s.is_primary)?.drive_type ?? 'nvme'
                  const hasBothTiers = myServers.some((s) => s.drive_type === 'nvme') && myServers.some((s) => s.drive_type === 'hdd')
                  const serversInTier = myServers.filter((s) => s.drive_type === tier)
                  function handleTierChange(t: 'nvme' | 'hdd') {
                    const inTier = myServers!.filter((s) => s.drive_type === t)
                    const primaryInTier = inTier.find((s) => s.is_primary)
                    setNewFolderDriveId(primaryInTier?.drive_id ?? inTier[0]?.drive_id ?? null)
                  }
                  return (
                    <>
                      {hasBothTiers
                        ? <TierToggle value={tier} onChange={handleTierChange} />
                        : <span className="text-xs text-gray-500 shrink-0">{tierLabel(tier)} tier</span>}
                      {serversInTier.length > 1
                        ? <ServerDropdown servers={serversInTier} value={newFolderDriveId ?? ''} onChange={setNewFolderDriveId} />
                        : serversInTier[0] && <span className="text-xs text-gray-500 shrink-0">{serversInTier[0].name}</span>}
                    </>
                  )
                })()}
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
                    <ShareButton onClick={() => setPendingShare({ type: 'folder', id: f.id, name: f.name })} title="Share folder" />
                    <DriveInfoButton folder={f} servers={myServers} isAdmin={!!user?.is_admin} />
                    <DeleteButton onClick={() => handleDeleteClick('folder', f.id, f.name)} title="Delete folder" />
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
                    <ShareButton onClick={() => setPendingShare({ type: 'file', id: f.id, name: f.name })} title="Share file" />
                    <DeleteButton onClick={() => handleDeleteClick('file', f.id, f.name)} title="Delete file" />
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
          folderName={folderId === 'root' ? 'root' : (folder?.name ?? 'This folder')}
          location={uploadDrive ? { name: uploadDrive.name, tier: uploadDrive.drive_type, isPinned: uploadDriveIsPinned } : undefined}
          redirectFolderName={uploadRedirectFolderName}
          user={user}
          onAddStorage={showStorageButtons ? () => setStorageModalReason('open') : undefined}
          onConfirm={(ignoreRedirectIndices) => {
            const filesToUpload = pendingFiles
            setPendingFiles([])
            startUpload(filesToUpload, uploadFolderId, () => {
              queryClient.invalidateQueries({ queryKey: ['folders', folderId] })
              queryClient.invalidateQueries({ queryKey: ['me'] })
            }, ignoreRedirectIndices)
          }}
          onCancel={() => setPendingFiles([])}
        />
      )}

      <UploadToast progress={progress} onDismiss={dismiss} />

      {storageModalReason && !readOnly && (
        <StorageUpgradeModal
          promptReason={storageModalReason === 'open' ? null : storageModalReason}
          onClose={() => setStorageModalReason(null)}
        />
      )}

      {/* Google Backup — service selection */}
      {serviceSelectOpen && (
        <GoogleServiceSelectModal
          onCancel={() => setServiceSelectOpen(false)}
          onContinue={handleGoogleServiceContinue}
        />
      )}

      {/* Google Backup — preparing / awaiting Photos selection */}
      {googleLoading && !googleBackupItems && (
        <GooglePhotosLoadingModal
          message={googleLoadingMsg}
          onCancel={handleCancelGoogleLoading}
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

      {pendingShare && (
        <ShareModal
          itemType={pendingShare.type}
          itemId={pendingShare.id}
          itemName={pendingShare.name}
          onClose={() => setPendingShare(null)}
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

function QuotaBar({ used, quota, onAddStorage }: { used: number; quota: number; onAddStorage?: () => void }) {
  const pct = quota > 0 ? (used / quota) * 100 : 0
  const color =
    pct >= 90 ? 'bg-red-500' :
    pct >= 50 ? 'bg-amber-400' :
                'bg-green-500'
  return (
    <div className="mb-4">
      <div className="flex justify-between text-xs text-gray-400 mb-1">
        <span>{formatSize(used)} used</span>
        <span className="flex items-center gap-1">
          {formatSize(quota)} quota
          {onAddStorage && (
            <button
              type="button"
              onClick={onAddStorage}
              title="Add storage"
              className="flex items-center bg-transparent border-0 p-0 text-blue-500 hover:text-blue-700 cursor-pointer transition-colors"
            >
              <MdAddCircleOutline className="text-sm" />
            </button>
          )}
        </span>
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

function ShareButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="cursor-pointer bg-transparent border-0 p-0.5 text-gray-300 hover:text-blue-500 transition-colors"
    >
      <MdShare className="text-lg" />
    </button>
  )
}

function DeleteButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="cursor-pointer bg-transparent border-0 p-0.5 text-gray-300 hover:text-red-500 transition-colors"
    >
      <MdDeleteOutline className="text-lg" />
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

// ── Storage tier/server pickers ─────────────────────────────────────────────────
//
// Shared by the inline folder creator and the per-folder drive-change popover
// below. The caller decides whether to render the interactive control or a
// static label — only show a real choice when the user actually has one
// (both tiers / more than one server in the selected tier).

// TierToggle reuses the exact color vocabulary from profile.tsx's server list
// (blue for nvme/"Fast", amber for hdd/"Standard").
function TierToggle({ value, onChange }: { value: 'nvme' | 'hdd'; onChange: (tier: 'nvme' | 'hdd') => void }) {
  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange('nvme')}
        title="Fast tier (NVMe)"
        className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md cursor-pointer transition-colors ${
          value === 'nvme' ? 'bg-blue-50 text-blue-600' : 'text-gray-400 hover:bg-gray-50'
        }`}
      >
        <MdBolt className="text-sm" /> Fast
      </button>
      <button
        type="button"
        onClick={() => onChange('hdd')}
        title="Standard tier (HDD)"
        className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md cursor-pointer transition-colors ${
          value === 'hdd' ? 'bg-amber-50 text-amber-600' : 'text-gray-400 hover:bg-gray-50'
        }`}
      >
        <MdStorage className="text-sm" /> Standard
      </button>
    </div>
  )
}

// ServerDropdown is a plain native <select> — there's no existing reusable
// dropdown component elsewhere in this codebase to prefer over one.
function ServerDropdown({
  servers, value, onChange,
}: { servers: MyServer[]; value: string; onChange: (driveId: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs border border-gray-200 rounded-md px-1.5 py-1 text-gray-700 bg-white cursor-pointer"
    >
      {servers.map((s) => (
        <option key={s.drive_id} value={s.drive_id}>{s.name}</option>
      ))}
    </select>
  )
}

function tierLabel(t: 'nvme' | 'hdd'): string {
  return t === 'nvme' ? 'Fast' : 'Standard'
}

// A drive option in the change-popover's server/tier picker — normalized from
// either the user's own allocations (MyServer) or, in admin preview mode, the
// full infrastructure listing (DriveSummary), so the picker logic is the same
// either way.
interface DriveOption {
  server_id: string
  drive_id: string
  name: string
  drive_type: 'nvme' | 'hdd'
}

function ownedDriveOptions(servers: MyServer[] | undefined): DriveOption[] {
  return (servers ?? []).map((s) => ({ server_id: s.server_id, drive_id: s.drive_id, name: s.name, drive_type: s.drive_type }))
}

function allDriveOptions(drives: DriveSummary[] | undefined): DriveOption[] {
  return (drives ?? [])
    .filter((d) => d.drive_is_active && d.server_is_active)
    .map((d) => ({ server_id: d.server_id, drive_id: d.drive_id, name: d.server_name, drive_type: d.drive_type }))
}

// ServerPicker selects a server (not a specific drive) — the tier for that
// server is chosen separately via TierToggle once a server is picked.
function ServerPicker({
  options, value, onChange,
}: { options: { id: string; name: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full text-xs border border-gray-200 rounded-md px-1.5 py-1 text-gray-700 bg-white cursor-pointer"
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>{o.name}</option>
      ))}
    </select>
  )
}

// DriveInfoButton shows a folder's current tier/server (resolved against the
// user's drives) and, on click, opens DriveChangePopover to change it.
function DriveInfoButton({ folder, servers, isAdmin }: { folder: Folder; servers: MyServer[] | undefined; isAdmin: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { drive, isPinned } = resolveDrive(folder.drive_id, servers)
  const label = drive
    ? `${isPinned ? '' : 'Default — '}${tierLabel(drive.drive_type)} tier · ${drive.name}`
    : 'Default storage location'

  useEffect(() => {
    if (!open) return
    function handleOutsideClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [open])

  return (
    <div ref={ref} className="relative inline-flex items-center">
      <button
        onClick={() => setOpen((o) => !o)}
        title={label}
        className="inline-flex items-center cursor-pointer bg-transparent border-0 p-0.5 text-gray-300 hover:text-gray-500 transition-colors"
      >
        <MdInfoOutline className="text-lg" />
      </button>
      {open && (
        <DriveChangePopover
          folder={folder}
          servers={servers}
          isAdmin={isAdmin}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

// DriveChangePopover shows the folder's current drive, fetches migration
// eligibility, and lets the user request a change (subject to the 3-per-
// folder/30-day rate limit enforced server-side). While a migration is
// pending/in_progress it shows live progress via the reused UploadToast.
// Admins get a "preview" toggle that swaps in the full infrastructure listing
// (all servers/tiers, owned or not) to see the full control surface without
// being able to actually fire a move.
function DriveChangePopover({
  folder, servers, isAdmin, onClose,
}: { folder: Folder; servers: MyServer[] | undefined; isAdmin: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const { eligibility, migration, progress, isActive } = useDriveMigrationProgress(folder.id, folder.name)
  const [previewMode, setPreviewMode] = useState(false)
  const { drive: current, isPinned } = resolveDrive(folder.drive_id, servers)

  const { data: infra } = useQuery({ ...infrastructureQueryOptions, enabled: previewMode })

  const options: DriveOption[] = previewMode ? allDriveOptions(infra?.drives) : ownedDriveOptions(servers)
  const uniqueServers = Array.from(
    new Map(options.map((o) => [o.server_id, { id: o.server_id, name: o.name }])).values(),
  )

  const [selectedServerId, setSelectedServerId] = useState(() => current?.server_id ?? '')
  const [selectedTier, setSelectedTier] = useState<'nvme' | 'hdd'>(() => current?.drive_type ?? 'nvme')

  // When preview mode toggles (or the infra listing loads), the option set
  // changes — re-validate the current selection against it.
  useEffect(() => {
    if (uniqueServers.length === 0) return
    if (!uniqueServers.some((s) => s.id === selectedServerId)) {
      setSelectedServerId(current?.server_id ?? uniqueServers[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode, infra])

  const tiersForSelectedServer = options.filter((o) => o.server_id === selectedServerId)

  useEffect(() => {
    if (tiersForSelectedServer.length > 0 && !tiersForSelectedServer.some((o) => o.drive_type === selectedTier)) {
      setSelectedTier(tiersForSelectedServer[0].drive_type)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedServerId, previewMode, infra])

  const selectedOption = tiersForSelectedServer.find((o) => o.drive_type === selectedTier) ?? tiersForSelectedServer[0]
  const driveId = selectedOption?.drive_id ?? ''

  const migrateMutation = useMutation({
    mutationFn: () => requestDriveMigration(folder.id, driveId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folders', folder.id, 'drive-migration'] })
    },
    onError: (err) => {
      notify('error', err instanceof ApiError ? err.message : 'Failed to start storage move')
    },
  })

  useEffect(() => {
    if (migration?.status === 'completed') {
      queryClient.invalidateQueries({ queryKey: ['folders'] })
    }
  }, [migration?.status, queryClient])

  const atLimit = !!eligibility && eligibility.recent_count >= eligibility.limit
  const hasChange = !!driveId && driveId !== (current?.drive_id ?? '')
  const canConfirm = hasChange && !atLimit && !migrateMutation.isPending && !previewMode

  return (
    <div className="absolute right-0 top-full mt-1 w-72 bg-white rounded-lg border border-gray-200 shadow-lg z-50 p-3">
      <div className="flex items-center justify-between gap-2 mb-3">
        <span className="text-xs text-gray-500 min-w-0 truncate">
          {current ? (
            <>
              {isPinned ? 'Storage' : 'Default storage'}:{' '}
              <span className="font-semibold text-gray-800">{current.name}</span>{' '}
              <TierIcon type={current.drive_type} />
            </>
          ) : (
            'Default storage location'
          )}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {isAdmin && (
            <button
              onClick={() => setPreviewMode((p) => !p)}
              title={previewMode ? 'Exit preview' : 'Preview all servers (admin)'}
              className={`cursor-pointer bg-transparent border-0 p-0.5 transition-colors ${previewMode ? 'text-purple-500 hover:text-purple-600' : 'text-gray-300 hover:text-gray-500'}`}
            >
              <MdVisibility className="text-base" />
            </button>
          )}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0.5">
            <MdClose className="text-sm" />
          </button>
        </div>
      </div>

      {previewMode && (
        <p className="text-[11px] text-purple-500 mb-2">Preview — showing every server; the move can&apos;t be confirmed from here.</p>
      )}

      {isActive && progress ? (
        <>
          <p className="text-xs text-gray-500 mb-1">Moving files… see progress below.</p>
          <UploadToast progress={progress} onDismiss={onClose} verb="Moving" />
        </>
      ) : (
        <>
          {uniqueServers.length > 1 && (
            <div className="mb-2">
              <ServerPicker options={uniqueServers} value={selectedServerId} onChange={setSelectedServerId} />
            </div>
          )}
          {tiersForSelectedServer.length > 1 && (
            <div className="mb-3">
              <TierToggle value={selectedTier} onChange={setSelectedTier} />
            </div>
          )}

          {atLimit && eligibility?.next_eligible_at && (
            <p className="text-xs text-amber-600 mb-2">
              Reached {eligibility.limit} storage changes for this folder this period — next available{' '}
              {new Date(eligibility.next_eligible_at).toLocaleDateString()}.
            </p>
          )}

          {hasChange && (
            <button
              onClick={() => migrateMutation.mutate()}
              disabled={!canConfirm}
              title={previewMode ? 'Preview mode — move is disabled' : undefined}
              className="w-full px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-md font-medium cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {previewMode ? 'Preview only' : 'Confirm move'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
