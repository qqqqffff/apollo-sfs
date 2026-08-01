import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MdAddCircleOutline,
  MdAlternateEmail,
  MdArrowBack,
  MdArrowUpward,
  MdBolt,
  MdAutoAwesome,
  MdCheck,
  MdCheckBox,
  MdCheckBoxOutlineBlank,
  MdChecklist,
  MdChevronRight,
  MdCloudQueue,
  MdCloudUpload,
  MdClose,
  MdDeleteOutline,
  MdEdit,
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
import { createFolder, moveFolder, renameFolder, requestDriveMigration } from '../../api/folders'
import { downloadUrl, fileQueryOptions, moveFile, previewUrl, renameFile } from '../../api/files'
import { detectionThumbUrl } from '../../api/recognition'
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
import { StorageBreakdownModal } from '../../components/StorageBreakdownModal'
import { ShareModal } from '../../components/ShareModal'
import { DeleteConfirmModal, readSkipDeleteCookie } from '../../components/DeleteConfirmModal'
import { FolderDeleteConfirmModal } from '../../components/FolderDeleteConfirmModal'
import { FolderBreadcrumb } from '../../components/FolderBreadcrumb'
import { HoverDonut } from '../../components/HoverDonut'
import { AccountBadges } from '../../components/GroupBadge'
import { RowActionsMenu, MenuRow } from '../../components/RowActionsMenu'
import { TierIcon } from '../../components/TierIcon'
import { StorageTierBars } from '../../components/StorageTierBars'
import { DriveDestinationPicker } from '../../components/DriveDestinationPicker'
import { UploadToast } from '../../components/UploadToast'
import { SortControls } from '../../components/SortControls'
import { SearchBar } from '../../components/SearchBar'
import { SelectionToolbar } from '../../components/SelectionToolbar'
import { BulkMoveModal, type BulkMoveItem } from '../../components/BulkMoveModal'
import { BulkDeleteConfirmModal } from '../../components/BulkDeleteConfirmModal'
import { useFileUpload } from '../../hooks/useFileUpload'
import { useDeleteJob, type DeleteTarget } from '../../hooks/useDeleteJob'
import { useDragDrop } from '../../hooks/useDragDrop'
import { useFileDrag, HOVER_OPEN_DELAY_MS } from '../../hooks/useFileDrag'
import { useSort, sortedFolders, sortedFiles } from '../../hooks/useSort'
import { useInfiniteFolderContents } from '../../hooks/useInfiniteFolderContents'
import { useFavorites } from '../../hooks/useFavorites'
import { useDriveMigrationProgress } from '../../hooks/useDriveMigrationProgress'
import { useImpersonation } from '../../context/ImpersonationContext'
import { FilesLayout, FilesSidebarToggle, parseFilesAction, type FilesAction } from '../../components/FilesSidebar'
import { GoogleServiceSelectModal } from '../../components/GoogleServiceSelectModal'
import { GoogleBackupModal } from '../../components/GoogleBackupModal'
import { GooglePhotosLoadingModal } from '../../components/GooglePhotosLoadingModal'
import type { GoogleServiceSelection } from '../../components/GoogleServiceSelectModal'
import {
  requestGoogleAccessToken,
  getGoogleUserEmail,
  listGoogleDriveFiles,
  pickGooglePhotosWeb,
  removeBackedUpFiles,
  uploadGoogleEntries,
  completeGoogleBackupRun,
  loadGoogleBackupSettings,
  type BackupEntry,
  type GoogleBackupItem,
} from '../../api/googleBackup'
import { EmailProviderSelectModal } from '../../components/EmailProviderSelectModal'
import { EmailRetrievalCriteriaModal } from '../../components/EmailRetrievalCriteriaModal'
import { EmailBackupModal } from '../../components/EmailBackupModal'
import { EmailBackupView } from '../../components/EmailBackupView'
import {
  fetchProgressFor,
  getGmailUserEmail,
  getMicrosoftUserEmail,
  listProviderMessages,
  requestGmailAccessToken,
  requestMicrosoftAccessToken,
  type EmailProvider,
  type EmailRetrievalCriteria,
  type FetchProgress,
  type ProviderEmailItem,
} from '../../api/emailProviders'
import {
  backupEmailEntries,
  completeEmailBackupRun,
  deleteProviderMessages,
  loadEmailBackupSettings,
  removeBackedUpMessages,
} from '../../api/emailBackup'
import { useBackgroundBackup, type BackgroundBackupState } from '../../hooks/useBackgroundBackup'
import { BackupProgressDetails, BackupRunControls } from '../../components/BackupProgress'
import { BackupCancelModal } from '../../components/BackupCancelModal'

export const Route = createFileRoute('/_auth/client/')({
  // All keys optional so navigations to /client elsewhere need not pass every
  // one. Only keys with a concrete value are included.
  validateSearch: (search: Record<string, unknown>): { file?: string; folder?: string; drive?: string; action?: FilesAction; recognitionGroup?: string } => {
    const out: { file?: string; folder?: string; drive?: string; action?: FilesAction; recognitionGroup?: string } = {}
    if (typeof search.file === 'string') out.file = search.file
    if (typeof search.folder === 'string') out.folder = search.folder
    if (typeof search.drive === 'string') out.drive = search.drive
    if (typeof search.recognitionGroup === 'string') out.recognitionGroup = search.recognitionGroup
    const action = parseFilesAction(search.action)
    if (action) out.action = action
    return out
  },
  component: RouteComponent,
})

function RouteComponent() {
  const { file: fileId, folder: folderId, drive: driveParam } = useSearch({ from: '/_auth/client/' })

  return (
    <FilesLayout>
      {folderId
        ? <FolderView folderId={folderId} fileId={fileId} />
        : <RootView driveParam={driveParam} fileId={fileId} />}
    </FilesLayout>
  )
}

// RootView resolves what the "super level" shows: the drive picker (a user with
// multiple drives and no default landing), or a single drive's root view (one
// drive, an explicit ?drive, or a saved default). While impersonating, the
// tier-first grouping is skipped — the admin sees the target user's whole root
// flat, since the drive list is the caller's own — so it renders the plain
// unscoped root exactly as before.
function RootView({ driveParam, fileId }: { driveParam?: string; fileId?: string }) {
  const { impersonatedUser } = useImpersonation()
  const { action: sidebarAction } = useSearch({ from: '/_auth/client/' })
  const { data: prefs } = useQuery(preferencesQueryOptions)
  const { data: myServers, isLoading } = useQuery({
    queryKey: ['storage', 'my-servers'],
    queryFn: listMyServers,
    enabled: impersonatedUser === null,
  })

  if (impersonatedUser !== null) return <FolderView folderId="root" fileId={fileId} />

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  const servers = myServers ?? []

  // No drives yet → plain root (its empty-state messaging applies). A single
  // drive always lands straight in it — there's no drive layer to choose from.
  if (servers.length === 0) return <FolderView folderId="root" fileId={fileId} />
  if (servers.length === 1) return <FolderView folderId="root" driveId={servers[0].drive_id} fileId={fileId} />

  // 'all' is the explicit "show the picker" sentinel set by the All storage
  // link, so it wins over the saved-default auto-landing (otherwise clicking
  // All storage would bounce straight back into the default drive).
  if (driveParam === DRIVE_OVERVIEW) return <DrivePicker servers={servers} />

  const named = driveParam && servers.find((s) => s.drive_id === driveParam)
  if (named) return <FolderView folderId="root" driveId={named.drive_id} fileId={fileId} />

  // Bare /client (no valid drive): land in the saved default when it still
  // exists, otherwise show the picker.
  const dflt = prefs?.default_drive_id && servers.find((s) => s.drive_id === prefs.default_drive_id)
  if (dflt) return <FolderView folderId="root" driveId={dflt.drive_id} fileId={fileId} />

  // A pending sidebar action (Google/email backup, new folder/collection)
  // travels as ?action= and is only ever consumed by the effect inside
  // FolderView — DrivePicker doesn't read it and would strand it in the URL
  // forever, silently swallowing the click. Land in a real drive (primary,
  // else the first) so the action still fires; the user can switch drives
  // afterward same as anyone else.
  if (sidebarAction) {
    const fallback = servers.find((s) => s.is_primary) ?? servers[0]
    return <FolderView folderId="root" driveId={fallback.drive_id} fileId={fileId} />
  }

  return <DrivePicker servers={servers} />
}

// DRIVE_OVERVIEW is the ?drive sentinel meaning "show the drive picker" — a real
// drive id is always a UUID, so this can never collide with one.
const DRIVE_OVERVIEW = 'all'

// DrivePicker is the "super level": the granular per-drive quota bars plus a
// clickable list of the drives (server & tier) the user owns. Clicking a drive
// enters that drive's root view. Shown only to multi-drive users with no saved
// default — single-drive users and defaults land straight in a drive.
function DrivePicker({ servers }: { servers: MyServer[] }) {
  const navigate = useNavigate()
  const { data: user } = useQuery(meQueryOptions)
  const openDrive = (driveId: string) =>
    navigate({ to: '/client', search: { file: undefined, drive: driveId } })

  return (
    <div>
      <div className="flex items-center gap-3 mb-5">
        <FilesSidebarToggle />
        <h2 className="text-lg font-semibold text-gray-900 mt-0 mb-0">My Files</h2>
        {(user?.is_premium || user?.is_admin) && (
          <AccountBadges user={user} className="text-[10px]" />
        )}
      </div>

      <StorageTierBars servers={servers} />

      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Your storage</h3>
      <ul className="list-none m-0 p-0">
        {servers.map((s) => {
          const isFast = s.drive_type === 'nvme'
          return (
            <li key={s.drive_id}>
              <button
                onClick={() => openDrive(s.drive_id)}
                className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg hover:bg-gray-50 cursor-pointer bg-transparent border-0 text-left transition-colors"
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isFast ? 'bg-blue-50' : 'bg-amber-50'}`}>
                  {isFast ? <MdBolt className="text-blue-600" /> : <MdStorage className="text-amber-500" />}
                </div>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-800">{tierLabel(s.drive_type)} · {s.name}</span>
                    {s.is_primary && (
                      <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-blue-50 text-blue-600 rounded">
                        Primary
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-gray-400">
                    {formatSize(s.used_bytes)} of {formatSize(s.quota_bytes)} used
                  </span>
                </span>
                <MdChevronRight className="text-gray-300 text-xl shrink-0" />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ── File view ─────────────────────────────────────────────────────────────────

function FileView({ fileId }: { fileId: string }) {
  const navigate = useNavigate()
  const { folder: currentFolder, drive: currentDrive } = useSearch({ from: '/_auth/client/' })
  const { data: file, isLoading, error } = useQuery(fileQueryOptions(fileId))

  function close() {
    navigate({ to: '/client', search: { file: undefined, folder: currentFolder, drive: currentDrive } })
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

function FolderView({ folderId, fileId, driveId }: { folderId: string | 'root'; fileId?: string; driveId?: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const { data: user } = useQuery(meQueryOptions)
  const { action: sidebarAction, recognitionGroup } = useSearch({ from: '/_auth/client/' })
  const { impersonatedUser } = useImpersonation()
  const readOnly = impersonatedUser !== null
  const isPremium = user?.is_premium || user?.is_admin
  const fileRef = useRef<HTMLInputElement>(null)
  const [pendingFiles, setPendingFiles] = useState<globalThis.File[]>([])
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null)
  const [pendingShare, setPendingShare] = useState<{ type: 'file' | 'folder'; id: string; name: string } | null>(null)
  const [search, setSearch] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [renaming, setRenaming] = useState<{ type: 'file' | 'folder'; id: string; ext: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [newFolderKind, setNewFolderKind] = useState<FolderKind>('regular')
  const [newFolderDriveId, setNewFolderDriveId] = useState<string | null>(null)
  const { progress, startUpload, retryFailed, dismiss } = useFileUpload()
  const { progress: deleteProgress, startDelete, dismiss: dismissDelete } = useDeleteJob()
  const onUploadSuccess = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['folders', folderId] })
    queryClient.invalidateQueries({ queryKey: ['me'] })
    queryClient.invalidateQueries({ queryKey: ['storage', 'my-servers'] })
  }, [queryClient, folderId])
  const { isDragging } = useDragDrop((dropped) => { if (!readOnly) setPendingFiles(dropped) })

  // ── Multi-select state ─────────────────────────────────────────────────────
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set())
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set())
  const [pendingBulkMove, setPendingBulkMove] = useState(false)
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false)
  const [bulkMovePending, setBulkMovePending] = useState(false)
  const [bulkDeletePending, setBulkDeletePending] = useState(false)

  // Selected ids only make sense against the folder they were selected in —
  // clear them (but keep selectionMode itself) whenever the user navigates.
  useEffect(() => {
    setSelectedFileIds(new Set())
    setSelectedFolderIds(new Set())
  }, [folderId])

  function clearSelection() {
    setSelectedFileIds(new Set())
    setSelectedFolderIds(new Set())
  }

  function toggleSelectionMode() {
    setSelectionMode((m) => {
      if (m) clearSelection()
      return !m
    })
  }

  function toggleSelectFile(id: string) {
    setSelectedFileIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function toggleSelectFolder(id: string) {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

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
  // Server/tier to preselect in the storage upgrade modal, set when it's
  // opened from a specific drive context (e.g. the upload modal's "Add
  // storage" action) so the flow lands where the user was already working.
  const [storageModalPreselect, setStorageModalPreselect] =
    useState<{ serverId: string; tier: 'nvme' | 'hdd' } | null>(null)
  const [showStorageBreakdown, setShowStorageBreakdown] = useState(false)
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
  // Background (window-closed) Google run: progress card, pause/cancel, and the
  // keep-or-remove outcome of a cancel.
  const googleBg = useBackgroundBackup()

  // ── Email Backup state ─────────────────────────────────────────────────────
  const [emailSelectOpen, setEmailSelectOpen] = useState(false)
  const [emailCriteriaFor, setEmailCriteriaFor] = useState<EmailProvider | null>(null)
  const [emailLoading, setEmailLoading] = useState(false)
  const [emailLoadingMsg, setEmailLoadingMsg] = useState('Loading your emails')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [emailBackup, setEmailBackup] = useState<{
    provider: EmailProvider
    accessToken: string
    accountEmail: string
    // Grows page by page — the picker opens as soon as the account is known
    // and fills in while the rest of the mailbox is still being retrieved.
    items: ProviderEmailItem[]
    fetching: boolean
    fetchProgress: FetchProgress | null
  } | null>(null)
  const emailCancelRef = useRef<(() => void) | null>(null)
  // Flipped by the picker's "Stop" button to end paging early, keeping what
  // has already arrived.
  const emailFetchStopRef = useRef(false)
  const emailBg = useBackgroundBackup([['email-backup']])

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
    else if (sidebarAction === 'email-backup' && isPremium) {
      setEmailError(null)
      setEmailSelectOpen(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarAction, user])

  // At a drive's root the listing is scoped to that drive; the primary drive
  // also owns NULL-drive rows (they resolve to the primary at read time).
  const rootDrive = folderId === 'root' && driveId ? myServers?.find((s) => s.drive_id === driveId) : undefined
  const driveScope = rootDrive ? { driveId: rootDrive.drive_id, includeUnassigned: rootDrive.is_primary } : undefined

  const {
    folder,
    folders: rawSubfolders,
    files: rawFiles,
    recognitionGroups,
    isLoading,
    error,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteFolderContents(folderId, search, impersonatedUser?.username, driveScope)

  // The drive (server & tier) the current view lives on: the scoped drive at a
  // drive root, otherwise the folder's own drive (NULL resolves to primary).
  // Drives the granular quota bar, uploads, and new-folder binding.
  const currentDrive = folderId === 'root'
    ? rootDrive
    : resolveDrive(folder?.drive_id ?? null, myServers).drive

  const moveFileMutation = useMutation({
    mutationFn: ({ fileId, targetFolderId }: { fileId: string; targetFolderId: string }) =>
      moveFile(fileId, targetFolderId),
    onSuccess: (_, { targetFolderId }) => {
      queryClient.invalidateQueries({ queryKey: ['folders'] })
      navigate({ to: '/client', search: { file: undefined, folder: targetFolderId } })
    },
    // Drag-and-drop had no failure feedback at all — a rejected move (e.g.
    // the target folder vanished mid-drag) silently did nothing, which reads
    // to the user as "drag and drop doesn't work" rather than an explained
    // failure.
    onError: (err) => notify('error', err instanceof ApiError ? err.message : 'Failed to move file'),
  })

  const moveFolderMutation = useMutation({
    mutationFn: ({ folderId, targetFolderId }: { folderId: string; targetFolderId: string }) =>
      moveFolder(folderId, targetFolderId),
    onSuccess: (_, { targetFolderId }) => {
      queryClient.invalidateQueries({ queryKey: ['folders'] })
      navigate({ to: '/client', search: { file: undefined, folder: targetFolderId } })
    },
    // Same as moveFileMutation above — and folder moves have a real,
    // frequently-hit rejection case a silent failure would otherwise hide:
    // ErrCrossDriveMove (api/routes/services/folder.go) rejects reparenting
    // a folder onto a target on a different drive/tier (a plain move only
    // rewrites parent_id — it can't relocate the subtree's bytes between
    // MinIO instances; that needs the drive-migration flow instead). Since
    // subfolders inherit their exact parent's drive, this fires whenever a
    // drag crosses a drive boundary, which is far more reachable once you're
    // navigating between nested folders than at a single drive's root
    // listing — previously that just looked like "drop did nothing."
    onError: (err) => notify('error', err instanceof ApiError ? err.message : 'Failed to move folder'),
  })

  // Shared by both bulk-move paths: the toolbar's Move modal (ids come from
  // the current selection state) and a multi-selection drag-and-drop (ids
  // come from the drag payload, captured at drag start — see
  // getSelectionSnapshot below). Mirrors what the single-item
  // moveFileMutation/moveFolderMutation already do on success (invalidate +
  // navigate into the destination), just batched.
  async function moveManyTo(fileIds: string[], folderIds: string[], targetFolderId: string) {
    setBulkMovePending(true)
    const results = await Promise.allSettled([
      ...fileIds.map((id) => moveFile(id, targetFolderId)),
      ...folderIds.map((id) => moveFolder(id, targetFolderId)),
    ])
    const total = results.length
    const failed = results.filter((r) => r.status === 'rejected').length
    setBulkMovePending(false)
    setPendingBulkMove(false)
    clearSelection()
    setSelectionMode(false)
    queryClient.invalidateQueries({ queryKey: ['folders'] })
    if (failed > 0) notify('error', `${total - failed} moved, ${failed} failed to move`)
    if (failed < total) navigate({ to: '/client', search: { file: undefined, folder: targetFolderId } })
  }

  function runBulkMove(targetFolderId: string) {
    moveManyTo(Array.from(selectedFileIds), Array.from(selectedFolderIds), targetFolderId)
  }

  async function runBulkDelete() {
    setBulkDeletePending(true)
    // Route through the same cascading job single-item delete uses — a
    // selected folder gets its subtree emptied first instead of a raw
    // deleteFolder() call that 409s "not empty" (e.g. an email backup folder
    // full of messages).
    const targets: DeleteTarget[] = selectedBulkItems.map((item) => ({
      type: item.kind,
      id: item.id,
      name: item.name,
      sizeBytes: item.size_bytes,
    }))
    const { failed } = await startDelete(targets)
    setBulkDeletePending(false)
    setPendingBulkDelete(false)
    clearSelection()
    setSelectionMode(false)
    queryClient.invalidateQueries({ queryKey: ['folders'] })
    queryClient.invalidateQueries({ queryKey: ['me'] })
    queryClient.invalidateQueries({ queryKey: ['storage', 'my-servers'] })
    if (failed > 0) notify('error', `${targets.length - failed} deleted, ${failed} failed`)
  }

  function handleBulkDeleteClick() {
    if (user && readSkipDeleteCookie(user.username)) runBulkDelete()
    else setPendingBulkDelete(true)
  }

  // Coalesced favorite/unfavorite: if every selected item is already
  // favorited, the action removes all of them; otherwise it adds only the
  // ones that aren't favorited yet (already-favorited selections are left
  // alone rather than being toggled off).
  function runBulkFavorite() {
    const allFavorited =
      Array.from(selectedFileIds).every((id) => favoriteFileIds.has(id)) &&
      Array.from(selectedFolderIds).every((id) => favoriteFolderIds.has(id))
    if (allFavorited) {
      selectedFileIds.forEach((id) => toggleFile(id))
      selectedFolderIds.forEach((id) => toggleFolder(id))
    } else {
      selectedFileIds.forEach((id) => { if (!favoriteFileIds.has(id)) toggleFile(id) })
      selectedFolderIds.forEach((id) => { if (!favoriteFolderIds.has(id)) toggleFolder(id) })
    }
  }

  const {
    draggingFileId, draggingFolderId, dragOverFolderId, dragOverBackground, dragOverCurrent,
    getFileDragHandlers, getFolderDragHandlers, getFolderDropHandlers, getListBackgroundDropHandlers,
    getCurrentFolderDropHandlers,
  } = useFileDrag(
    (fileId, targetFolderId) => moveFileMutation.mutate({ fileId, targetFolderId }),
    (folderId, targetFolderId) => moveFolderMutation.mutate({ folderId, targetFolderId }),
    (hoveredFolderId) => openFolder(hoveredFolderId),
    (id, kind) => {
      const inSelection = kind === 'file' ? selectedFileIds.has(id) : selectedFolderIds.has(id)
      if (!inSelection || selectedFileIds.size + selectedFolderIds.size <= 1) return null
      return { fileIds: Array.from(selectedFileIds), folderIds: Array.from(selectedFolderIds) }
    },
    (fileIds, folderIds, targetFolderId) => moveManyTo(fileIds, folderIds, targetFolderId),
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
    // Bind the new folder to the current drive context: the scoped drive at a
    // drive root, or the parent folder's drive when nested (the backend inherits
    // the parent's drive for subfolders regardless, so this is just a hint).
    setNewFolderDriveId(currentDrive?.drive_id ?? myServers?.find((s) => s.is_primary)?.drive_id ?? null)
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

  // runDelete drives one delete through useDeleteJob's progress-reporting job
  // (a non-empty folder has its whole subtree emptied first) and reuses the
  // upload toast to show status instead of a single pass/fail notification.
  function runDelete(target: DeleteTarget) {
    void startDelete([target]).then(({ failed }) => {
      queryClient.invalidateQueries({ queryKey: ['folders'] })
      queryClient.invalidateQueries({ queryKey: ['me'] })
      queryClient.invalidateQueries({ queryKey: ['storage', 'my-servers'] })
      if (failed > 0) notify('error', `Failed to delete "${target.name}"`)
    })
  }

  const renameFileMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameFile(id, name),
    onSuccess: () => {
      setRenaming(null)
      queryClient.invalidateQueries({ queryKey: ['folders', folderId] })
    },
    onError: (err) => notify('error', err instanceof ApiError ? err.message : 'Failed to rename file'),
  })

  const renameFolderMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameFolder(id, name),
    onSuccess: () => {
      setRenaming(null)
      queryClient.invalidateQueries({ queryKey: ['folders', folderId] })
    },
    onError: (err) => notify('error', err instanceof ApiError ? err.message : 'Failed to rename folder'),
  })

  // Files keep their extension locked during rename — only the base name is
  // editable — since changing it silently would change how the OS/browser
  // treats the downloaded file. Folders have no extension concept.
  function startRename(type: 'file' | 'folder', id: string, name: string) {
    const { base, ext } = type === 'file' ? splitExtension(name) : { base: name, ext: '' }
    setRenaming({ type, id, ext })
    setRenameValue(base)
  }

  function confirmRename() {
    if (!renaming) return
    const base = renameValue.trim()
    if (!base) return
    const name = base + renaming.ext
    if (renaming.type === 'file') renameFileMutation.mutate({ id: renaming.id, name })
    else renameFolderMutation.mutate({ id: renaming.id, name })
  }

  function cancelRename() {
    setRenaming(null)
    setRenameValue('')
  }

  function handleDeleteClick(type: 'file' | 'folder', id: string, name: string, sizeBytes: number) {
    const target: DeleteTarget = { type, id, name, sizeBytes }
    if (user && readSkipDeleteCookie(user.username)) {
      runDelete(target)
    } else {
      setPendingDelete(target)
    }
  }

  function openFolder(id: string) {
    navigate({ to: '/client', search: { file: undefined, folder: id } })
  }

  function openFile(id: string) {
    navigate({
      to: '/client',
      search: {
        file: id,
        folder: folderId === 'root' ? undefined : folderId,
        drive: folderId === 'root' ? driveId : undefined,
      },
    })
  }

  // Replace-style navigation used by the media viewer as the user scrolls
  // between items — keeps the URL in sync without piling up history entries.
  function navigateToFile(id: string) {
    navigate({ to: '/client', search: { file: id, folder: folderId === 'root' ? undefined : folderId }, replace: true })
  }

  function closeFile() {
    navigate({ to: '/client', search: { file: undefined, folder: folderId === 'root' ? undefined : folderId } })
  }

  function goBack() {
    if (folderId === 'root') return
    if (folder?.parent_id) {
      navigate({ to: '/client', search: { file: undefined, folder: folder.parent_id } })
    } else {
      // Top-level folder → back to its drive's root (or the super level when the
      // user has a single drive and there's no drive layer to return to).
      navigate({ to: '/client', search: { file: undefined, drive: currentDrive?.drive_id } })
    }
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

  // ── Email Backup handlers ──────────────────────────────────────────────────

  function handleEmailProviderContinue(provider: EmailProvider) {
    setEmailSelectOpen(false)
    setEmailError(null)
    setEmailCriteriaFor(provider)
  }

  async function handleEmailCriteriaContinue(provider: EmailProvider, criteria: EmailRetrievalCriteria) {
    setEmailCriteriaFor(null)
    setEmailLoading(true)
    setEmailLoadingMsg('Signing in to your email account')
    setEmailError(null)

    let cancelled = false
    // Microsoft needs a popup pre-opened synchronously before any awaits —
    // same constraint as the Google Photos picker tab.
    let msPopup: Window | null = null
    if (provider === 'microsoft') {
      msPopup = window.open('about:blank', '_blank', 'width=480,height=640')
    }
    emailFetchStopRef.current = false
    emailCancelRef.current = () => {
      cancelled = true
      emailFetchStopRef.current = true
      msPopup?.close()
    }

    try {
      const token = provider === 'gmail'
        ? await requestGmailAccessToken()
        : await requestMicrosoftAccessToken(msPopup)
      if (cancelled) return

      const accountEmail = provider === 'gmail'
        ? await getGmailUserEmail(token)
        : await getMicrosoftUserEmail(token)
      if (cancelled) return
      if (!accountEmail) {
        setEmailError('Could not determine the signed-in email address.')
        return
      }

      // Retrieval pages 200 at a time and a large criteria can take minutes, so
      // the picker opens on an empty table right away and each page is dropped
      // into it as it lands — the user can filter and select while the rest is
      // still downloading, instead of watching a spinner.
      setEmailBackup({ provider, accessToken: token, accountEmail, items: [], fetching: true, fetchProgress: null })
      setEmailLoading(false)

      const { items, truncated } = await listProviderMessages(provider, token, criteria, {
        onPage: (page, fetchProgress) => {
          if (cancelled) return
          setEmailBackup((s) => (s ? { ...s, items: page, fetchProgress } : s))
        },
        shouldStop: () => cancelled || emailFetchStopRef.current,
      })
      if (cancelled) { setEmailBackup(null); return }

      setEmailBackup((s) => (s
        ? { ...s, items, fetching: false, fetchProgress: fetchProgressFor(criteria, items) }
        : s))

      if (items.length === 0) {
        setEmailBackup(null)
        setEmailError('No emails were found matching your criteria.')
        return
      }
      if (truncated) {
        setEmailError(
          `Stopped after the ${items.length.toLocaleString()}-email safety limit — your criteria may not be fully covered.`,
        )
      }
    } catch (e: any) {
      setEmailBackup(null)
      if (cancelled) return
      const msg: string = e?.message ?? ''
      // Swallow silent dismissals (popup closed, user cancelled)
      if (msg && !msg.toLowerCase().includes('popup_closed') && !msg.toLowerCase().includes('cancel')) {
        setEmailError(msg)
      }
    } finally {
      emailCancelRef.current = null
      setEmailLoading(false)
    }
  }

  // Ends an in-flight retrieval: the picker's "Stop" button, and closing the
  // picker outright — otherwise paging would carry on against the provider for
  // a window nobody is looking at any more.
  function stopEmailFetch() {
    emailFetchStopRef.current = true
  }

  function handleEmailBackupDone(backupFolderId: string | null) {
    setEmailBackup(null)
    queryClient.invalidateQueries({ queryKey: ['folders'] })
    queryClient.invalidateQueries({ queryKey: ['me'] })
    queryClient.invalidateQueries({ queryKey: ['email-backup'] })
    if (backupFolderId) {
      navigate({ to: '/client', search: { file: undefined, folder: backupFolderId } })
    }
  }

  function handleStartEmailBackground(items: ProviderEmailItem[], folder: { id: string; drive_id: string | null }) {
    if (!emailBackup) return
    const { provider, accessToken, accountEmail } = emailBackup
    setEmailBackup(null)
    const settings = loadEmailBackupSettings()

    emailBg.start({
      total: items.length,
      totalBytes: items.reduce((sum, i) => sum + i.sizeEstimate, 0),
      unit: 'email',
      // Every message lands on the backup folder's own drive, so its quota bar
      // can be credited as each one arrives.
      driveId: folder.drive_id ?? myServers?.find((s) => s.is_primary)?.drive_id ?? null,
      run: ({ control, onProgress }) =>
        backupEmailEntries(items, provider, accessToken, folder.id, {
          control,
          folderName: accountEmail,
          onProgress,
        }),
      rollback: (res) => removeBackedUpMessages(res.uploadedMessageIds),
      onSettled: async (res, removed) => {
        // A rollback just deleted the copies that would have justified
        // trashing the originals provider-side.
        if (settings.deleteAfter && removed === 0 && res.backedUpIds.length > 0) {
          await deleteProviderMessages(provider, accessToken, res.backedUpIds)
        }
        // Best effort — the backup itself already succeeded.
        completeEmailBackupRun({
          folder_id: folder.id,
          email_address: accountEmail,
          provider,
          uploaded: Math.max(0, res.uploaded - removed),
          duplicates: res.duplicates,
          errors: res.errors,
          notify: settings.notify,
        }).catch(() => {})
      },
    })
  }

  function handleStartBackground(entries: BackupEntry[], token: string) {
    setGoogleBackupItems(null)
    googleBg.start({
      total: entries.length,
      totalBytes: entries.reduce((sum, e) => sum + (e.googleItem.size ?? 0), 0),
      unit: 'file',
      run: ({ control, onProgress }) => uploadGoogleEntries(entries, token, { control, onProgress }),
      rollback: (res) => removeBackedUpFiles(res.uploadedFileIds),
      onSettled: (res, removed) => {
        // Best effort — the backup itself already succeeded.
        completeGoogleBackupRun({
          uploaded: Math.max(0, res.uploaded - removed),
          duplicates: res.duplicates,
          errors: res.errors,
          notify: loadGoogleBackupSettings().notify,
        }).catch(() => {})
      },
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
        initialRecognitionGroup={recognitionGroup}
        activeFileId={fileId}
        onBack={goBack}
        onOpenFolder={openFolder}
        onOpenFile={openFile}
        onNavigateFile={navigateToFile}
        onCloseFile={closeFile}
      />
    )
  }

  // Email backup folders render as a mail viewer (sender sidebar, message
  // list, reading pane) instead of the standard file/folder listing.
  if (folder && folder.kind === 'email') {
    if (!isPremium) {
      return (
        <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
          <MdAlternateEmail className="text-6xl text-teal-300" />
          <h2 className="text-lg font-semibold text-gray-900 m-0">Email Backups</h2>
          <p className="text-sm text-gray-500 max-w-xs">
            Email backups are a premium feature. Upgrade to browse your backed-up mail.
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
    return <EmailBackupView folder={folder} readOnly={readOnly} onBack={goBack} />
  }

  // Previewing a single file inside a regular (non-media) folder still uses
  // the generic modal-style preview — the full-screen scrolling viewer above
  // only applies within media collections.
  if (fileId) {
    return <FileView fileId={fileId} />
  }

  const subfolders = sortedFolders(rawSubfolders, sort)
  const files = sortedFiles(rawFiles, sort)
  // null = root upload (no folder); backend accepts absent folder_id for root.
  const uploadFolderId: string | null = folderId === 'root' ? null : folderId
  // Root uploads in a drive view pin to that drive; inside a folder the folder's
  // own drive governs (resolveDrive falls back to primary when unpinned).
  const { drive: uploadDrive, isPinned: uploadDriveIsPinned } = folderId === 'root'
    ? { drive: currentDrive, isPinned: !!currentDrive }
    : resolveDrive(folder?.drive_id ?? null, myServers)
  const hasContent = rawSubfolders.length > 0 || rawFiles.length > 0 || recognitionGroups.length > 0
  const noResults = search && !isLoading && !hasNextPage && !hasContent
  const viewingUser = impersonatedUser ?? user

  // Selection derived state — the items list feeds both bulk modals (name +
  // size to display), and allSelectedFavorited drives the toolbar's
  // Favorite/Unfavorite coalescing (see runBulkFavorite above).
  const selectionCount = selectedFileIds.size + selectedFolderIds.size
  const selectedBulkItems: BulkMoveItem[] = [
    ...subfolders.filter((f) => selectedFolderIds.has(f.id)).map((f) => ({ id: f.id, name: f.name, size_bytes: f.size_bytes, kind: 'folder' as const })),
    ...files.filter((f) => selectedFileIds.has(f.id)).map((f) => ({ id: f.id, name: f.name, size_bytes: f.size_bytes, kind: 'file' as const })),
  ]
  const allSelectedFavorited = selectionCount > 0 &&
    Array.from(selectedFileIds).every((id) => favoriteFileIds.has(id)) &&
    Array.from(selectedFolderIds).every((id) => favoriteFolderIds.has(id))

  // Photos/videos get silently redirected server-side into the auto-upload
  // folder unless we're already uploading into a media collection — mirrors
  // FileService.resolveUploadFolder so the modal's lock icons match reality.
  const uploadRedirectFolderName =
    autoUploadTargetId && folder?.kind !== 'media'
      ? (subfolders.find((f) => f.id === autoUploadTargetId)?.name ?? null)
      : null

  return (
    <div>
      {(() => {
        // Drive crumb data for the breadcrumb: the drive whose view we're in,
        // with an "All storage" step back to the super level when the user owns
        // more than one drive (and isn't impersonating).
        const multiDrive = !readOnly && (myServers?.length ?? 0) > 1
        const driveCrumb = !readOnly && currentDrive
          ? {
              id: currentDrive.drive_id,
              name: currentDrive.name,
              type: currentDrive.drive_type,
              showAllStorage: multiDrive,
            }
          : undefined
        const goToDriveRoot = (dId: string) => navigate({ to: '/client', search: { file: undefined, drive: dId } })
        const goToAllStorage = () => navigate({ to: '/client', search: { file: undefined, drive: DRIVE_OVERVIEW } })
        return folderId !== 'root' ? (
          <div className="mb-2">
            <div className="flex items-center gap-3 mb-5">
              <FilesSidebarToggle />
              <FolderBreadcrumb
                folderId={folderId}
                onNavigate={(id) => navigate({ to: '/client', search: { file: undefined, folder: id, drive: id ? undefined : currentDrive?.drive_id } })}
                asUsername={impersonatedUser?.username}
                drive={driveCrumb}
                onNavigateDrive={goToDriveRoot}
                onNavigateAllStorage={goToAllStorage}
                getFolderDropHandlers={!readOnly ? getFolderDropHandlers : undefined}
                dragOverFolderId={!readOnly ? dragOverFolderId : null}
                currentDropHandlers={!readOnly && folder ? getCurrentFolderDropHandlers(folder.id) : undefined}
                dragOverCurrent={!readOnly && dragOverCurrent}
              />
            </div>
            {folder && (
              <div className="flex items-center gap-1">
                <h2 className="text-lg font-semibold text-gray-900 m-0">{folder.name}</h2>
                {!readOnly && (
                  <DriveInfoButton folder={folder} servers={myServers} isAdmin={!!user?.is_admin} align="left" />
                )}
              </div>
            )}
            {/* Persistent, stacked drop targets — both stay mounted for the
                whole time a file/folder is being dragged (not just once the
                pointer happens to be over them), so there's always somewhere
                obvious to drop regardless of how the drag got here (e.g. a
                spring-loaded hover-navigate that left no sibling row under
                the pointer). Each row lights up independently via its own
                dragOver state when the drag is actually inside it.

                Deliberately `fixed`, not part of the flow. Appearing mid-drag
                is the whole point of this panel, so anywhere in the document
                flow it would shove the row list down the instant the drag
                began — moving the folder the user was already aiming at out
                from under the pointer, and landing the drop on whichever row
                slid into its place. (Real-Chromium proof of exactly that
                mis-drop, from when this was an inline block, is in
                src/__tests__/e2e/dnd-depth.spec.ts.) Pinned to the viewport it
                shifts nothing, and it stays reachable without scrolling
                mid-drag in a long folder. */}
            {!readOnly && folder && (draggingFileId || draggingFolderId) && (
              <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-70 flex w-[min(30rem,92vw)] flex-col gap-1.5">
                <DropZoneRow
                  icon={<MdFolderOpen className="text-base shrink-0" />}
                  label={`Drop here to move into "${folder.name}"`}
                  active={dragOverCurrent}
                  handlers={getCurrentFolderDropHandlers(folder.id)}
                />
                {folder.parent_id && (
                  <DropZoneRow
                    icon={<MdArrowUpward className="text-base shrink-0" />}
                    label="Drop here to move to the parent folder"
                    active={dragOverBackground}
                    handlers={getListBackgroundDropHandlers(folder.parent_id)}
                  />
                )}
              </div>
            )}
          </div>
        ) : !readOnly && currentDrive ? (
          <div className="mb-5">
            {driveCrumb?.showAllStorage && (
              <button
                onClick={goToAllStorage}
                className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline bg-transparent border-0 p-0 cursor-pointer mb-2"
              >
                <MdArrowBack className="text-base" /> All storage
              </button>
            )}
            <div className="flex items-center gap-3">
              <FilesSidebarToggle />
              <h2 className="text-lg font-semibold text-gray-900 mt-0 mb-0 flex items-center gap-1.5">
                <TierIcon type={currentDrive.drive_type} /> {tierLabel(currentDrive.drive_type)} · {currentDrive.name}
              </h2>
              {(user?.is_premium || user?.is_admin) && (
                <AccountBadges user={user} className="text-[10px]" />
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 mb-5">
            {/* The sidebar drawer is a file-browsing/actions tool — not applicable
                on the storage-preview (root) screen, so it's not rendered here at
                all (subfolder headers above still show it). */}
            <h2 className="text-lg font-semibold text-gray-900 mt-0 mb-0">
              {readOnly ? `${impersonatedUser!.username}'s Storage` : 'My Storage'}
            </h2>
            <DriveInfoButton folder={null} servers={myServers} isAdmin={!!user?.is_admin} align="left" />
          </div>
        )
      })()}

      {!readOnly && (
        <div className={`gap-2 mb-4 ${folderId === 'root' && !currentDrive ? 'hidden sm:flex' : 'flex'}`}>
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
            data-tour="upload-button"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
          >
            <MdUploadFile className="text-base" /> Upload
          </button>
          {hasContent && (
            <button
              onClick={toggleSelectionMode}
              title={selectionMode ? 'Exit selection mode' : 'Select multiple files and folders'}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg font-medium cursor-pointer border transition-colors ${
                selectionMode
                  ? 'bg-blue-50 text-blue-600 border-blue-200'
                  : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              <MdChecklist className="text-base" /> Select
            </button>
          )}
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

      {/* Granular quota bar: the current drive's own used/quota when we're in a
          drive view (own account), else the account-wide aggregate (used while
          impersonating or when drives haven't loaded). */}
      {currentDrive && !readOnly ? (
        <QuotaBar
          used={currentDrive.used_bytes}
          quota={currentDrive.quota_bytes}
          label={`${tierLabel(currentDrive.drive_type)} · ${currentDrive.name}`}
          onAddStorage={showStorageButtons ? () => setStorageModalReason('open') : undefined}
        />
      ) : viewingUser && (
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

      {/* Email Backup error */}
      {emailError && (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-600">
          <span className="flex-1">{emailError}</span>
          <button onClick={() => setEmailError(null)} className="text-red-400 hover:text-red-600 cursor-pointer"><MdClose /></button>
        </div>
      )}

      {/* Background Google Backup progress card */}
      {googleBg.state && (
        <BackgroundBackupCard
          state={googleBg.state}
          title={googleBg.state.running ? 'Backing up from Google…' : 'Google Backup complete'}
          icon={
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0" aria-hidden="true">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
          }
          onTogglePause={googleBg.togglePause}
          onCancel={googleBg.requestCancel}
          onDismiss={googleBg.dismiss}
          busy={googleBg.rollbackBusy}
        />
      )}

      {/* Background Email Backup progress card */}
      {emailBg.state && (
        <BackgroundBackupCard
          state={emailBg.state}
          title={emailBg.state.running ? 'Backing up your email…' : 'Email Backup complete'}
          icon={<MdAlternateEmail className="text-teal-500 text-sm shrink-0" />}
          onTogglePause={emailBg.togglePause}
          onCancel={emailBg.requestCancel}
          onDismiss={emailBg.dismiss}
          busy={emailBg.rollbackBusy}
        />
      )}

      {/* Cancel confirmations for the background runs */}
      {googleBg.cancelPrompt && googleBg.state && (
        <BackupCancelModal
          storedCount={googleBg.state.storedCount}
          storedBytes={googleBg.state.storedBytes}
          unit="file"
          busy={googleBg.rollbackBusy}
          onRemove={() => googleBg.resolveCancel('remove')}
          onKeep={() => googleBg.resolveCancel('keep')}
          onResume={googleBg.resumeFromPrompt}
        />
      )}
      {emailBg.cancelPrompt && emailBg.state && (
        <BackupCancelModal
          storedCount={emailBg.state.storedCount}
          storedBytes={emailBg.state.storedBytes}
          unit="email"
          busy={emailBg.rollbackBusy}
          onRemove={() => emailBg.resolveCancel('remove')}
          onKeep={() => emailBg.resolveCancel('keep')}
          onResume={emailBg.resumeFromPrompt}
        />
      )}

      <div data-tour="search-bar">
        <SearchBar value={search} onChange={setSearch} />
      </div>

      <div className="relative rounded-xl p-4 min-h-52">
      {!search && !hasContent && (
        <p className="text-sm text-gray-400 mt-4">
          {folderId === 'root' ? 'No files yet. Upload something to get started.' : 'This folder is empty.'}
        </p>
      )}
      {noResults && <p className="text-sm text-gray-400">No results for &ldquo;{search}&rdquo;.</p>}

      {/* Labeled AI-recognition groups matching the search (premium). */}
      {search && recognitionGroups.length > 0 && (
        <section className="mb-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">People &amp; groups</h3>
          <div className="flex flex-wrap gap-2">
            {recognitionGroups.map((g) => (
              <button
                key={g.id}
                onClick={() =>
                  navigate({
                    to: '/client',
                    search: { file: undefined, folder: g.collection_id, recognitionGroup: g.id },
                  })
                }
                className="inline-flex items-center gap-2 pl-1 pr-3 py-1 border border-gray-200 rounded-full hover:bg-gray-50 cursor-pointer transition-colors bg-white"
                title={`${g.label} in ${g.collection_name}`}
              >
                <span className="w-7 h-7 rounded-full overflow-hidden bg-gray-100 flex items-center justify-center shrink-0">
                  {g.kind !== 'object' && g.cover_detection_id ? (
                    <img src={detectionThumbUrl(g.cover_detection_id)} alt="" className="w-full h-full object-cover" />
                  ) : g.cover_file_id ? (
                    <img src={previewUrl(g.cover_file_id)} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <MdAutoAwesome className="text-amber-400 text-sm" />
                  )}
                </span>
                <span className="text-sm text-gray-700">{g.label}</span>
                <span className="text-[10px] text-gray-400">
                  {g.file_count} · {g.collection_name}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

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
                {/* The new folder is bound to the current drive context (the
                    drive whose view this is, or the parent folder's drive for a
                    subfolder). It's fixed, not a chooser — a folder subtree can
                    never straddle tiers — so we just show where it will land. */}
                {currentDrive && (
                  <span className="inline-flex items-center gap-1 text-xs text-gray-500 shrink-0">
                    <TierIcon type={currentDrive.drive_type} /> {tierLabel(currentDrive.drive_type)} · {currentDrive.name}
                  </span>
                )}
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
                className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors hover:shadow-sm ${
                  !readOnly ? (selectionMode ? 'cursor-pointer' : 'cursor-grab') : ''
                } ${
                  dragOverFolderId === f.id
                    ? 'bg-blue-50 ring-2 ring-blue-300 ring-inset'
                    : 'hover:bg-gray-50'
                } ${draggingFolderId === f.id ? 'opacity-40' : ''}`}
              >
                {selectionMode && (
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleSelectFolder(f.id) }}
                    aria-label={selectedFolderIds.has(f.id) ? 'Deselect folder' : 'Select folder'}
                    className="shrink-0 cursor-pointer bg-transparent border-0 p-0.5 text-blue-500 hover:text-blue-600"
                  >
                    {selectedFolderIds.has(f.id) ? <MdCheckBox className="text-lg" /> : <MdCheckBoxOutlineBlank className="text-lg text-gray-300" />}
                  </button>
                )}
                {renaming?.type === 'folder' && renaming.id === f.id ? (
                  <>
                    {f.kind === 'media'
                      ? <MdPhotoLibrary className="text-purple-400 text-lg shrink-0" />
                      : f.kind === 'email'
                        ? <MdAlternateEmail className="text-teal-500 text-lg shrink-0" title="Email backup" />
                        : <MdFolder className="text-blue-400 text-lg shrink-0" />}
                    <input
                      autoFocus
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') confirmRename()
                        if (e.key === 'Escape') cancelRename()
                      }}
                      className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-gray-800"
                    />
                    <button
                      onClick={confirmRename}
                      disabled={!renameValue.trim() || renameFolderMutation.isPending}
                      title="Save"
                      className="text-green-500 hover:text-green-700 disabled:opacity-30 cursor-pointer bg-transparent border-0 p-0.5 transition-colors"
                    >
                      <MdCheck className="text-lg" />
                    </button>
                    <button
                      onClick={cancelRename}
                      title="Cancel"
                      className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0.5 transition-colors"
                    >
                      <MdClose className="text-lg" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => selectionMode ? toggleSelectFolder(f.id) : openFolder(f.id)}
                      className="flex-1 flex items-center gap-2 bg-transparent border-0 cursor-pointer text-left text-sm text-gray-800 hover:text-gray-900 p-0 min-w-0"
                    >
                      {f.kind === 'media'
                        ? <MdPhotoLibrary className="text-purple-400 text-lg shrink-0" />
                        : f.kind === 'email'
                          ? <MdAlternateEmail className="text-teal-500 text-lg shrink-0" title="Email backup" />
                          : <MdFolder className="text-blue-400 text-lg shrink-0" />}
                      <span className="truncate">{f.name}</span>
                      {!readOnly && dragOverFolderId === f.id && (
                        <HoverDonut durationMs={HOVER_OPEN_DELAY_MS} className="text-blue-500" />
                      )}
                    </button>
                    <span className="text-xs text-gray-400 shrink-0 hidden sm:inline">
                      {new Date(f.created_at).toLocaleDateString()}
                    </span>
                    <span className="text-xs text-gray-400 shrink-0">{formatSize(f.size_bytes)}</span>
                    {!readOnly && !selectionMode && (
                      <>
                        <div className="hidden sm:flex items-center gap-0.5 shrink-0">
                          {f.kind === 'media' && (
                            <AutoUploadButton
                              active={autoUploadTargetId === f.id}
                              onClick={() => toggleAutoUploadTarget(f.id)}
                            />
                          )}
                          <StarButton active={favoriteFolderIds.has(f.id)} onClick={() => toggleFolder(f.id)} title={favoriteFolderIds.has(f.id) ? 'Remove from favorites' : 'Add to favorites'} />
                          <RenameButton onClick={() => startRename('folder', f.id, f.name)} title="Rename folder" />
                          <ShareButton onClick={() => setPendingShare({ type: 'folder', id: f.id, name: f.name })} title="Share folder" />
                          <DriveInfoButton folder={f} servers={myServers} isAdmin={!!user?.is_admin} />
                          <DeleteButton onClick={() => handleDeleteClick('folder', f.id, f.name, f.size_bytes)} title="Delete folder" />
                        </div>
                        <div className="sm:hidden">
                          <RowActionsMenu>
                            {f.kind === 'media' && (
                              <MenuRow label={autoUploadTargetId === f.id ? 'Auto-upload target' : 'Set auto-upload target'}>
                                <AutoUploadButton
                                  active={autoUploadTargetId === f.id}
                                  onClick={() => toggleAutoUploadTarget(f.id)}
                                />
                              </MenuRow>
                            )}
                            <MenuRow label={favoriteFolderIds.has(f.id) ? 'Remove from favorites' : 'Add to favorites'}>
                              <StarButton active={favoriteFolderIds.has(f.id)} onClick={() => toggleFolder(f.id)} title={favoriteFolderIds.has(f.id) ? 'Remove from favorites' : 'Add to favorites'} />
                            </MenuRow>
                            <MenuRow label="Rename folder">
                              <RenameButton onClick={() => startRename('folder', f.id, f.name)} title="Rename folder" />
                            </MenuRow>
                            <MenuRow label="Share folder">
                              <ShareButton onClick={() => setPendingShare({ type: 'folder', id: f.id, name: f.name })} title="Share folder" />
                            </MenuRow>
                            <MenuRow label="Storage location">
                              <DriveInfoButton folder={f} servers={myServers} isAdmin={!!user?.is_admin} />
                            </MenuRow>
                            <MenuRow label="Delete folder">
                              <DeleteButton onClick={() => handleDeleteClick('folder', f.id, f.name, f.size_bytes)} title="Delete folder" />
                            </MenuRow>
                          </RowActionsMenu>
                        </div>
                      </>
                    )}
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
                className={`flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-50 hover:shadow-sm transition-colors ${
                  !readOnly ? (selectionMode ? 'cursor-pointer' : 'cursor-grab') : ''
                } ${draggingFileId === f.id ? 'opacity-40' : ''}`}
              >
                {selectionMode && (
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleSelectFile(f.id) }}
                    aria-label={selectedFileIds.has(f.id) ? 'Deselect file' : 'Select file'}
                    className="shrink-0 cursor-pointer bg-transparent border-0 p-0.5 text-blue-500 hover:text-blue-600"
                  >
                    {selectedFileIds.has(f.id) ? <MdCheckBox className="text-lg" /> : <MdCheckBoxOutlineBlank className="text-lg text-gray-300" />}
                  </button>
                )}
                {renaming?.type === 'file' && renaming.id === f.id ? (
                  <>
                    <MdInsertDriveFile className="text-gray-400 text-lg shrink-0" />
                    <input
                      autoFocus
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') confirmRename()
                        if (e.key === 'Escape') cancelRename()
                      }}
                      className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-gray-800"
                    />
                    {renaming.ext && <span className="text-sm text-gray-400 shrink-0" title="File extension can't be changed">{renaming.ext}</span>}
                    <button
                      onClick={confirmRename}
                      disabled={!renameValue.trim() || renameFileMutation.isPending}
                      title="Save"
                      className="text-green-500 hover:text-green-700 disabled:opacity-30 cursor-pointer bg-transparent border-0 p-0.5 transition-colors"
                    >
                      <MdCheck className="text-lg" />
                    </button>
                    <button
                      onClick={cancelRename}
                      title="Cancel"
                      className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0.5 transition-colors"
                    >
                      <MdClose className="text-lg" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => selectionMode ? toggleSelectFile(f.id) : openFile(f.id)}
                      className="flex-1 flex items-center gap-2 bg-transparent border-0 cursor-pointer text-left text-sm text-gray-800 hover:text-gray-900 p-0 min-w-0"
                    >
                      <MdInsertDriveFile className="text-gray-400 text-lg shrink-0" />
                      <span className="truncate">{f.name}</span>
                    </button>
                    <span className="text-xs text-gray-400 shrink-0 hidden sm:inline">
                      {new Date(f.created_at).toLocaleDateString()}
                    </span>
                    <span className="text-xs text-gray-400 shrink-0">{formatSize(f.size_bytes)}</span>
                    {!readOnly && !selectionMode && (
                      <>
                        <div className="hidden sm:flex items-center gap-0.5 shrink-0">
                          <StarButton active={favoriteFileIds.has(f.id)} onClick={() => toggleFile(f.id)} title={favoriteFileIds.has(f.id) ? 'Remove from favorites' : 'Add to favorites'} />
                          <RenameButton onClick={() => startRename('file', f.id, f.name)} title="Rename file" />
                          <ShareButton onClick={() => setPendingShare({ type: 'file', id: f.id, name: f.name })} title="Share file" />
                          <DeleteButton onClick={() => handleDeleteClick('file', f.id, f.name, f.size_bytes)} title="Delete file" />
                        </div>
                        <div className="sm:hidden">
                          <RowActionsMenu>
                            <MenuRow label={favoriteFileIds.has(f.id) ? 'Remove from favorites' : 'Add to favorites'}>
                              <StarButton active={favoriteFileIds.has(f.id)} onClick={() => toggleFile(f.id)} title={favoriteFileIds.has(f.id) ? 'Remove from favorites' : 'Add to favorites'} />
                            </MenuRow>
                            <MenuRow label="Rename file">
                              <RenameButton onClick={() => startRename('file', f.id, f.name)} title="Rename file" />
                            </MenuRow>
                            <MenuRow label="Share file">
                              <ShareButton onClick={() => setPendingShare({ type: 'file', id: f.id, name: f.name })} title="Share file" />
                            </MenuRow>
                            <MenuRow label="Delete file">
                              <DeleteButton onClick={() => handleDeleteClick('file', f.id, f.name, f.size_bytes)} title="Delete file" />
                            </MenuRow>
                          </RowActionsMenu>
                        </div>
                      </>
                    )}
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
      </div>

      {pendingFiles.length > 0 && user && !readOnly && (
        <UploadModal
          files={pendingFiles}
          folderName={folderId === 'root' ? 'root' : (folder?.name ?? 'This folder')}
          location={uploadDrive ? {
            name: uploadDrive.name,
            tier: uploadDrive.drive_type,
            isPinned: uploadDriveIsPinned,
            serverId: uploadDrive.server_id,
            usedBytes: uploadDrive.used_bytes,
            quotaBytes: uploadDrive.quota_bytes,
          } : undefined}
          redirectFolderName={uploadRedirectFolderName}
          user={user}
          onAddStorage={showStorageButtons ? () => {
            setStorageModalPreselect(uploadDrive ? { serverId: uploadDrive.server_id, tier: uploadDrive.drive_type } : null)
            setStorageModalReason('open')
          } : undefined}
          onViewBreakdown={() => setShowStorageBreakdown(true)}
          onConfirm={(ignoreRedirectIndices) => {
            const filesToUpload = pendingFiles
            setPendingFiles([])
            // Pin root uploads to the drive whose view we're in; inside a folder
            // the folder's own drive governs (pass undefined).
            startUpload(filesToUpload, uploadFolderId, onUploadSuccess, ignoreRedirectIndices, folderId === 'root' ? driveId : undefined)
          }}
          onCancel={() => setPendingFiles([])}
        />
      )}

      <UploadToast progress={progress} onDismiss={dismiss} onRetry={() => retryFailed(onUploadSuccess)} />
      <UploadToast progress={deleteProgress} onDismiss={dismissDelete} verb="Deleting" unit="items" doneWord="deleted" />

      {storageModalReason && !readOnly && (
        <StorageUpgradeModal
          promptReason={storageModalReason === 'open' ? null : storageModalReason}
          initialSelection={storageModalPreselect}
          onClose={() => { setStorageModalReason(null); setStorageModalPreselect(null) }}
        />
      )}

      {showStorageBreakdown && (
        <StorageBreakdownModal
          servers={myServers ?? []}
          onClose={() => setShowStorageBreakdown(false)}
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

      {/* Email Backup — provider selection */}
      {emailSelectOpen && (
        <EmailProviderSelectModal
          onCancel={() => setEmailSelectOpen(false)}
          onContinue={handleEmailProviderContinue}
        />
      )}

      {/* Email Backup — retrieval criteria (amount / date / size) */}
      {emailCriteriaFor && (
        <EmailRetrievalCriteriaModal
          provider={emailCriteriaFor}
          onCancel={() => setEmailCriteriaFor(null)}
          onContinue={(criteria) => handleEmailCriteriaContinue(emailCriteriaFor, criteria)}
        />
      )}

      {/* Email Backup — signing in / loading messages */}
      {emailLoading && !emailBackup && (
        <GooglePhotosLoadingModal
          message={emailLoadingMsg}
          hint="Finish signing in to your email account in the popup, then come back here — your inbox loads automatically."
          onCancel={() => emailCancelRef.current?.()}
        />
      )}

      {/* Email Backup — picker + upload modal */}
      {emailBackup && user && (
        <EmailBackupModal
          provider={emailBackup.provider}
          accessToken={emailBackup.accessToken}
          accountEmail={emailBackup.accountEmail}
          items={emailBackup.items}
          fetching={emailBackup.fetching}
          fetchProgress={emailBackup.fetchProgress}
          onStopFetching={stopEmailFetch}
          quotaBytes={user.storage_quota_bytes}
          usedBytes={user.storage_used_bytes}
          myServers={myServers}
          onClose={() => { stopEmailFetch(); setEmailBackup(null) }}
          onDone={handleEmailBackupDone}
          onStartBackground={handleStartEmailBackground}
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

      {pendingDelete && pendingDelete.type === 'folder' && (
        <FolderDeleteConfirmModal
          folder={{ id: pendingDelete.id, name: pendingDelete.name, sizeBytes: pendingDelete.sizeBytes }}
          username={user?.username ?? ''}
          usedBytes={currentDrive ? currentDrive.used_bytes : (viewingUser?.storage_used_bytes ?? 0)}
          quotaBytes={currentDrive ? currentDrive.quota_bytes : (viewingUser?.storage_quota_bytes ?? 0)}
          quotaLabel={currentDrive ? `${tierLabel(currentDrive.drive_type)} · ${currentDrive.name}` : undefined}
          onConfirm={() => {
            runDelete(pendingDelete)
            setPendingDelete(null)
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingDelete && pendingDelete.type === 'file' && (
        <DeleteConfirmModal
          name={pendingDelete.name}
          username={user?.username ?? ''}
          onConfirm={() => {
            runDelete(pendingDelete)
            setPendingDelete(null)
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {!readOnly && (
        <SelectionToolbar
          count={selectionCount}
          allFavorited={allSelectedFavorited}
          onMove={() => setPendingBulkMove(true)}
          onDelete={handleBulkDeleteClick}
          onToggleFavorite={runBulkFavorite}
          onClose={clearSelection}
        />
      )}

      {pendingBulkMove && currentDrive && (
        <BulkMoveModal
          items={selectedBulkItems}
          driveId={currentDrive.drive_id}
          includeUnassigned={currentDrive.is_primary}
          isPending={bulkMovePending}
          onConfirm={runBulkMove}
          onClose={() => setPendingBulkMove(false)}
        />
      )}

      {pendingBulkDelete && (
        <BulkDeleteConfirmModal
          items={selectedBulkItems}
          username={user?.username ?? ''}
          usedBytes={currentDrive ? currentDrive.used_bytes : (viewingUser?.storage_used_bytes ?? 0)}
          quotaBytes={currentDrive ? currentDrive.quota_bytes : (viewingUser?.storage_quota_bytes ?? 0)}
          quotaLabel={currentDrive ? `${tierLabel(currentDrive.drive_type)} · ${currentDrive.name}` : undefined}
          isPending={bulkDeletePending}
          onConfirm={runBulkDelete}
          onCancel={() => setPendingBulkDelete(false)}
        />
      )}

      {isDragging && !readOnly && (
        <div className="fixed inset-0 bg-blue-500/10 border-4 border-dashed border-blue-400 flex items-center justify-center z-999 pointer-events-none">
          <div className="bg-white/95 rounded-2xl px-12 py-6 text-center shadow-xl">
            <MdFolderOpen className="text-5xl text-blue-500 mx-auto mb-2" />
            <div className="text-lg font-semibold text-blue-600">Drop files to upload</div>
            <div className="text-sm text-gray-400 mt-1">
              to {folderId === 'root' ? 'My Storage' : (folder?.name ?? 'this folder')}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Shared components ─────────────────────────────────────────────────────────

// One row of the persistent stacked drag-and-drop target panel (current
// folder / parent folder) floating over the page while a drag is active — see
// FolderView, including why it floats rather than sitting in the flow.
// `active` drives the hover highlight; `handlers` come straight from
// useFileDrag (getCurrentFolderDropHandlers / getListBackgroundDropHandlers).
function DropZoneRow({
  icon, label, active, handlers,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  handlers: {
    onDragEnter: (e: React.DragEvent) => void
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}) {
  return (
    <div
      {...handlers}
      className={`flex items-center gap-2 rounded-lg border-2 border-dashed px-3 py-2 text-sm shadow-lg transition-colors ${
        active ? 'bg-blue-50 border-blue-400 text-blue-700' : 'bg-white/95 border-gray-300 text-gray-500'
      }`}
    >
      {icon}
      {label}
    </div>
  )
}

function QuotaBar({ used, quota, onAddStorage, label }: { used: number; quota: number; onAddStorage?: () => void; label?: string }) {
  const pct = quota > 0 ? (used / quota) * 100 : 0
  const color =
    pct >= 90 ? 'bg-red-500' :
    pct >= 50 ? 'bg-amber-400' :
                'bg-green-500'
  return (
    <div className="mb-4">
      <div className="flex justify-between text-xs text-gray-400 mb-1">
        <span>{label ? `${label} — ` : ''}{formatSize(used)} used</span>
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

// BackgroundBackupCard is the toolbar card a backup keeps running behind once
// its picker window is closed: counts, the file currently being written, the
// run's total size, and the pause/cancel controls. Shared by the Google and
// email flows, which differ only in icon and wording.
function BackgroundBackupCard({ state, title, icon, onTogglePause, onCancel, onDismiss, busy }: {
  state: BackgroundBackupState
  title: string
  icon: React.ReactNode
  onTogglePause: () => void
  onCancel: () => void
  onDismiss: () => void
  busy: boolean
}) {
  const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0
  const barColor = state.running
    ? (state.paused ? 'bg-amber-400' : 'bg-blue-500')
    : state.errors > 0 ? 'bg-amber-500' : 'bg-green-500'

  return (
    <div className="mb-3 px-3 py-2.5 bg-white border border-gray-200 rounded-lg shadow-sm flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {icon}
          <span className="text-xs font-semibold text-gray-700 truncate">
            {state.paused && state.running ? 'Backup paused' : title}
          </span>
        </div>
        {state.running ? (
          <BackupRunControls
            paused={state.paused}
            busy={busy}
            onTogglePause={onTogglePause}
            onCancel={onCancel}
            compact
          />
        ) : (
          <button onClick={onDismiss} className="text-gray-400 hover:text-gray-600 cursor-pointer">
            <MdClose className="text-sm" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs text-gray-500 shrink-0">{state.done}/{state.total}</span>
      </div>
      {state.running && (
        <BackupProgressDetails
          currentPath={state.currentPath}
          storedBytes={state.storedBytes}
          totalBytes={state.totalBytes}
          paused={state.paused}
        />
      )}
      {state.note && <p className="text-xs text-amber-600 m-0">{state.note}</p>}
      {!state.running && !state.note && (
        <p className={`text-xs m-0 ${state.errors > 0 ? 'text-amber-600' : 'text-green-600'}`}>
          {[
            `${state.uploaded} backed up`,
            state.duplicates > 0 ? `${state.duplicates} duplicate${state.duplicates !== 1 ? 's' : ''}` : null,
            state.errors > 0 ? `${state.errors} failed` : null,
          ].filter(Boolean).join(' · ')}
        </p>
      )}
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

function RenameButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="cursor-pointer bg-transparent border-0 p-0.5 text-gray-300 hover:text-emerald-500 transition-colors"
    >
      <MdEdit className="text-lg" />
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
// user's drives) and, on click, opens a popover with the details. For a real
// folder that's DriveChangePopover (also lets the user request a move); for
// the virtual root (folder === null, e.g. the "My Files" header) there's
// nothing to migrate, so it opens the read-only RootLocationPopover instead —
// root uploads always use the dynamic-routing default (resolveDrive(null, …)).
function DriveInfoButton({
  folder, servers, isAdmin, align = 'right',
}: { folder: Folder | null; servers: MyServer[] | undefined; isAdmin: boolean; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { drive, isPinned } = resolveDrive(folder?.drive_id ?? null, servers)
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
        folder ? (
          <DriveChangePopover
            folder={folder}
            servers={servers}
            isAdmin={isAdmin}
            align={align}
            onClose={() => setOpen(false)}
          />
        ) : (
          <RootLocationPopover drive={drive} isPinned={isPinned} align={align} onClose={() => setOpen(false)} />
        )
      )}
    </div>
  )
}

// RootLocationPopover is the read-only counterpart to DriveChangePopover for
// the virtual root: there's no folder row to pin/migrate, so it just explains
// where new root-level uploads land today.
function RootLocationPopover({
  drive, isPinned, align, onClose,
}: { drive: MyServer | undefined; isPinned: boolean; align: 'left' | 'right'; onClose: () => void }) {
  return (
    <div className={`absolute ${align === 'left' ? 'left-0' : 'right-0'} top-full mt-1 w-64 bg-white rounded-lg border border-gray-200 shadow-lg z-50 p-3`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs font-semibold text-gray-700">Storage location</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0.5">
          <MdClose className="text-sm" />
        </button>
      </div>
      {drive ? (
        <>
          <p className="text-xs text-gray-500 m-0 mb-1.5">
            Files uploaded here use your {isPinned ? 'assigned' : 'primary'} drive by default:
          </p>
          <p className="text-xs font-semibold text-gray-800 m-0 flex items-center gap-1">
            {drive.name} <TierIcon type={drive.drive_type} /> {tierLabel(drive.drive_type)} tier
          </p>
        </>
      ) : (
        <p className="text-xs text-gray-500 m-0">No storage server assigned yet.</p>
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
  folder, servers, isAdmin, align = 'right', onClose,
}: { folder: Folder; servers: MyServer[] | undefined; isAdmin: boolean; align?: 'left' | 'right'; onClose: () => void }) {
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
  // Destination folder on the target drive (null = the drive's root). Reset
  // whenever the target drive changes (below, once driveId is known).
  const [destParentId, setDestParentId] = useState<string | null>(null)

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
  const selectedDriveIsPrimary = servers?.find((s) => s.drive_id === driveId)?.is_primary ?? false

  // A different target drive means a different destination tree — reset the
  // chosen destination folder back to the drive's root.
  useEffect(() => {
    setDestParentId(null)
  }, [driveId])

  const migrateMutation = useMutation({
    mutationFn: () => requestDriveMigration(folder.id, driveId, destParentId),
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
    <div className={`absolute ${align === 'left' ? 'left-0' : 'right-0'} top-full mt-1 w-72 bg-white rounded-lg border border-gray-200 shadow-lg z-50 p-3`}>
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

          {hasChange && !previewMode && driveId && (
            <div className="mb-2">
              <p className="text-[11px] text-gray-500 mb-1">Move into which folder on the destination?</p>
              <DriveDestinationPicker
                driveId={driveId}
                includeUnassigned={selectedDriveIsPrimary}
                excludeFolderId={folder.id}
                value={destParentId}
                onSelect={(id) => setDestParentId(id)}
              />
            </div>
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

// splitExtension separates a file name into its editable base and its
// extension (including the leading dot). Leading-dot dotfiles (".gitignore")
// and names with no dot are treated as having no extension.
function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot) }
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
