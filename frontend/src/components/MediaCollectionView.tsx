import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MdAdd,
  MdArrowBack,
  MdAutoAwesome,
  MdCheck,
  MdCheckBox,
  MdCheckBoxOutlineBlank,
  MdChecklist,
  MdClose,
  MdCreateNewFolder,
  MdFilterAlt,
  MdInfoOutline,
  MdMenu,
  MdMovie,
  MdInsertDriveFile,
  MdPhotoLibrary,
  MdUploadFile,
  MdVisibility,
  MdVisibilityOff,
} from 'react-icons/md'
import { getMediaFolder, getMediaFileIds, createFolder } from '../api/folders'
import { deleteFile, hideFile, unhideFile, previewUrl, streamUrl } from '../api/files'
import { RetryImg } from './RetryImg'
import { favoriteFile, favoritesQueryOptions, unfavoriteFile } from '../api/favorites'
import { copyToCollection, removeFromCollection } from '../api/collections'
import { listDevices } from '../api/devices'
import { meQueryOptions } from '../api/me'
import { recognitionGroupsQueryOptions, recognitionStatusQueryOptions } from '../api/recognition'
import { listMyServers, resolveDrive } from '../api/storage'
import { useNotification } from '../context/NotificationContext'
import { useFileUpload } from '../hooks/useFileUpload'
import { useFavorites } from '../hooks/useFavorites'
import { useVirtualGrid } from '../hooks/useVirtualGrid'
import { BulkDeleteConfirmModal } from './BulkDeleteConfirmModal'
import { CollectionInfoModal } from './CollectionInfoModal'
import { MediaFilterPanel, groupLabel, summarizeMediaFilters } from './MediaFilterPanel'
import { MediaSelectionToolbar } from './MediaSelectionToolbar'
import { MediaViewerPage } from './MediaViewerPage'
import { RecognitionGroupsModal } from './RecognitionGroupsModal'
import { UploadModal } from './UploadModal'
import { StorageBreakdownModal } from './StorageBreakdownModal'
import { UploadToast } from './UploadToast'
import { EMPTY_MEDIA_FILTERS, countMediaFilters } from '../types/api'
import type { Device, File, Folder, HiddenMode, MediaFilters, MediaSort } from '../types/api'

// Items-per-row control: keeps grid tiles from shrinking below 100x100px —
// matches the grid's Tailwind gap-3 (0.75rem = 12px).
const GRID_GAP_PX = 12
const MIN_TILE_PX = 100
const GRID_COLS_STORAGE_KEY = 'apollo-sfs:media-grid-cols'

// Fallback height a tile's caption strip adds on top of its square thumbnail,
// used only until a real tile has been measured.
const ESTIMATED_TILE_CAPTION_PX = 45

// Page size requested per fetch. The grid only ever renders a couple of
// screenfuls, so pulling the server's maximum per round trip costs nothing on
// screen and keeps a fast scroll ahead of the network.
const MEDIA_PAGE_SIZE = 128

// How many bulk actions (hide, delete, copy…) run at once. A filter-driven
// selection can cover thousands of items, and these hit the per-user
// bulk-data rate limit one request per file.
const BULK_CONCURRENCY = 6

interface Props {
  folderId: string
  folder: Folder
  readOnly: boolean
  // Deep link from a search result: auto-open the groups modal on this group.
  initialRecognitionGroup?: string
  // Set when a file search param names an item in this collection — renders
  // the full-screen viewer in place of the generic single-file preview.
  activeFileId?: string
  onBack: () => void
  onOpenFolder: (id: string) => void
  onOpenFile: (id: string) => void
  // Replace-style navigation fired as the viewer scrolls between items, and
  // the handler that closes it back to the grid.
  onNavigateFile: (id: string) => void
  onCloseFile: () => void
}

// useInfiniteMedia paginates a media collection's files (and first-page subfolders).
function useInfiniteMedia(folderId: string, sort: MediaSort, hidden: HiddenMode, filters: MediaFilters) {
  const query = useInfiniteQuery({
    queryKey: ['media', folderId, sort, hidden, filters],
    queryFn: ({ pageParam }) =>
      getMediaFolder(folderId, {
        sort,
        hidden,
        filters,
        fileCursor: pageParam || undefined,
        fileLimit: MEDIA_PAGE_SIZE,
        folderLimit: pageParam ? 0 : undefined,
      }),
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

// runBatched applies fn to every id with a bounded number in flight, and
// reports how many failed. Used by every bulk selection action.
async function runBatched<T>(ids: T[], fn: (id: T) => Promise<unknown>): Promise<number> {
  let failed = 0
  for (let i = 0; i < ids.length; i += BULK_CONCURRENCY) {
    const results = await Promise.allSettled(ids.slice(i, i + BULK_CONCURRENCY).map(fn))
    failed += results.filter((r) => r.status === 'rejected').length
  }
  return failed
}

export function MediaCollectionView({
  folderId, folder, readOnly, initialRecognitionGroup, activeFileId,
  onBack, onOpenFolder, onOpenFile, onNavigateFile, onCloseFile,
}: Props) {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const { data: user } = useQuery(meQueryOptions)
  const { data: devicesData } = useQuery({ queryKey: ['devices'], queryFn: listDevices })
  const isPremium = !!(user?.is_premium || user?.is_admin)
  const { data: myServers } = useQuery({ queryKey: ['storage', 'my-servers'], queryFn: listMyServers })
  const { drive: uploadDrive, isPinned: uploadDriveIsPinned } = resolveDrive(folder.drive_id, myServers)
  const { favoriteFileIds, toggleFile: toggleFavoriteFile } = useFavorites()
  const [sort, setSort] = useState<MediaSort>('taken_at')
  const [hidden, setHidden] = useState<HiddenMode>('hide')
  const [filters, setFilters] = useState<MediaFilters>(EMPTY_MEDIA_FILTERS)
  const [showFilters, setShowFilters] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [infoFile, setInfoFile] = useState<File | null>(null)
  const [showCollectionInfo, setShowCollectionInfo] = useState(false)
  const [showGroups, setShowGroups] = useState(!!initialRecognitionGroup)
  const fileRef = useRef<HTMLInputElement>(null)
  const [pendingFiles, setPendingFiles] = useState<globalThis.File[]>([])
  const [showStorageBreakdown, setShowStorageBreakdown] = useState(false)
  const { progress, startUpload, retryFailed, dismiss } = useFileUpload()
  const onUploadSuccess = useCallback(() => {
    invalidate()
    queryClient.invalidateQueries({ queryKey: ['me'] })
  }, [queryClient]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Multi-select state ─────────────────────────────────────────────────────
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // Human-readable summaries of the filters a selection was built from — one
  // chip per "select matching" the user ran (they union together).
  const [selectionFilterChips, setSelectionFilterChips] = useState<string[]>([])
  const [isSelectingByFilter, setIsSelectingByFilter] = useState(false)
  const [bulkPending, setBulkPending] = useState(false)
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false)

  // Below `lg` the controls row becomes a slide-in drawer (same pattern as
  // the files page's side control panel) instead of a wrapping toolbar.
  const [controlsOpen, setControlsOpen] = useState(false)

  useEffect(() => {
    if (!controlsOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setControlsOpen(false) }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', handleKey)
    }
  }, [controlsOpen])

  // Items-per-row: measure the grid's actual rendered width and cap the
  // column count so tiles never shrink below 100x100px. Attached as a ref
  // callback rather than a mount effect because the grid element comes and
  // goes with the empty state.
  const gridRef = useRef<HTMLDivElement | null>(null)
  const gridObserver = useRef<ResizeObserver | null>(null)
  const [gridWidth, setGridWidth] = useState(0)

  const attachGrid = useCallback((el: HTMLDivElement | null) => {
    gridRef.current = el
    gridObserver.current?.disconnect()
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) setGridWidth(width)
    })
    observer.observe(el)
    gridObserver.current = observer
    const width = el.getBoundingClientRect().width
    if (width) setGridWidth(width)
  }, [])

  useEffect(() => () => gridObserver.current?.disconnect(), [])

  const maxCols = gridWidth > 0 ? Math.max(1, Math.floor((gridWidth + GRID_GAP_PX) / (MIN_TILE_PX + GRID_GAP_PX))) : 4
  const colOptions = Array.from({ length: maxCols }, (_, i) => i + 1)

  const [colsPref, setColsPref] = useState<number | null>(() => {
    const raw = localStorage.getItem(GRID_COLS_STORAGE_KEY)
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : null
  })
  const cols = Math.min(colsPref ?? Math.min(4, maxCols), maxCols)

  function setCols(n: number) {
    setColsPref(n)
    localStorage.setItem(GRID_COLS_STORAGE_KEY, String(n))
  }

  // Polls while indexing is active; disabled entirely for non-premium users.
  const { data: recognitionStatus } = useQuery(recognitionStatusQueryOptions(folderId, isPremium))
  const recognitionEnabled = !!recognitionStatus?.enabled

  // Labeled groups, used both to name the filter chips and (inside the panel)
  // to offer the label checkboxes.
  const { data: labeledGroupData } = useQuery({
    ...recognitionGroupsQueryOptions(folderId, undefined, true),
    enabled: recognitionEnabled,
  })
  const groupNames = useMemo(
    () => new Map((labeledGroupData?.groups ?? []).map((g) => [g.id, groupLabel(g)])),
    [labeledGroupData],
  )

  const { subfolders, files, isLoading, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteMedia(folderId, sort, hidden, filters)

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

  // ── Virtualized grid ───────────────────────────────────────────────────────
  // Only the rows near the viewport are rendered; the container reserves the
  // full height of every row so the scrollbar (and the user's position in it)
  // never shifts as tiles mount and unmount. One extra row of skeleton tiles
  // is reserved while another page is still to come, so scrolling into
  // not-yet-loaded territory lands on placeholders rather than a hard stop.
  const cellWidth = gridWidth > 0 ? (gridWidth - GRID_GAP_PX * (cols - 1)) / cols : MIN_TILE_PX
  const [tileCaptionPx, setTileCaptionPx] = useState<number | null>(null)
  const rowHeight = cellWidth + (tileCaptionPx ?? ESTIMATED_TILE_CAPTION_PX)

  // Measured off the first rendered tile: everything a tile adds on top of its
  // square thumbnail (caption lines + borders), which depends on font metrics
  // rather than layout width, so one measurement holds for every tile.
  const measureTile = useCallback((el: HTMLDivElement | null) => {
    if (!el || gridWidth <= 0) return
    const extra = el.getBoundingClientRect().height - cellWidth
    if (extra > 0) {
      setTileCaptionPx((prev) => (prev === null || Math.abs(prev - extra) > 0.5 ? extra : prev))
    }
  }, [gridWidth, cellWidth])

  const placeholderCount = hasNextPage ? cols : 0
  const { startIndex, endIndex, stride, totalHeight } = useVirtualGrid({
    itemCount: files.length + placeholderCount,
    cols,
    rowHeight,
    gap: GRID_GAP_PX,
    containerRef: gridRef,
  })

  const firstRow = Math.floor(startIndex / cols)
  const lastRow = Math.ceil(endIndex / cols)
  const visibleRows = Array.from({ length: Math.max(0, lastRow - firstRow) }, (_, i) => firstRow + i)

  // Infinite scroll: the render window reaching past the loaded items (which
  // it does a full 2 viewports early, thanks to the overscan) pulls the next
  // page in.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && endIndex >= files.length) {
      fetchNextPage()
    }
  }, [endIndex, files.length, hasNextPage, isFetchingNextPage, fetchNextPage])

  // A new sort/filter is a new list — start it from the top rather than
  // stranding the user mid-scroll in unrelated results.
  const listKey = `${sort}|${hidden}|${JSON.stringify(filters)}`
  const firstListRender = useRef(true)
  useEffect(() => {
    if (firstListRender.current) {
      firstListRender.current = false
      return
    }
    window.scrollTo({ top: 0 })
  }, [listKey])

  // ── Scroll restoration around the full-screen viewer ───────────────────────
  // Closing the viewer must land back on the item that was on screen — which
  // is whatever the user last swiped to, not the one they opened. The viewer
  // locks body scroll while it's up, so the grid's position is not preserved
  // on its own; we re-derive it from that item's row instead.
  const [restoreToFileId, setRestoreToFileId] = useState<string | null>(null)
  const lastActiveFileId = useRef<string | undefined>(activeFileId)

  useEffect(() => {
    const previous = lastActiveFileId.current
    lastActiveFileId.current = activeFileId
    if (previous && !activeFileId) setRestoreToFileId(previous)
  }, [activeFileId])

  useEffect(() => {
    if (!restoreToFileId || activeFileId) return
    const index = files.findIndex((f) => f.id === restoreToFileId)
    const el = gridRef.current
    if (index < 0 || !el) return
    // Wait a frame so the viewer's body-scroll lock has been released and the
    // grid has its full height back before we scroll.
    const frame = requestAnimationFrame(() => {
      const gridTop = el.getBoundingClientRect().top + window.scrollY
      const rowTop = gridTop + Math.floor(index / cols) * stride
      // Centre the row when it fits; otherwise just bring it to the top.
      const offset = Math.max(0, (window.innerHeight - rowHeight) / 2)
      window.scrollTo({ top: Math.max(0, rowTop - offset), behavior: 'auto' })
    })
    setRestoreToFileId(null)
    return () => cancelAnimationFrame(frame)
  }, [restoreToFileId, activeFileId, files, cols, stride, rowHeight])

  // ── Selection ──────────────────────────────────────────────────────────────
  // Selected ids only make sense against the collection they were picked in.
  useEffect(() => {
    setSelectedIds(new Set())
    setSelectionFilterChips([])
  }, [folderId])

  function clearSelection() {
    setSelectedIds(new Set())
    setSelectionFilterChips([])
  }

  function toggleSelectionMode() {
    setSelectionMode((m) => {
      if (m) clearSelection()
      return !m
    })
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Filter-driven selection: adds every item matching the filter to the
  // current selection (rather than narrowing the view), so applying several
  // different filters in a row unions them into one selection. The match set
  // has to come from the server — the grid only holds the pages fetched so far.
  async function selectByFilter(applied: MediaFilters) {
    if (countMediaFilters(applied) === 0) return
    setIsSelectingByFilter(true)
    try {
      const { file_ids, truncated } = await getMediaFileIds(folderId, { sort, hidden, filters: applied })
      setSelectedIds((prev) => new Set([...prev, ...file_ids]))
      setSelectionFilterChips((prev) => {
        const summary = summarizeMediaFilters(applied, groupNames)
        return prev.includes(summary) ? prev : [...prev, summary]
      })
      if (truncated) {
        notify('error', 'Too many matches to select them all — the first 20,000 were selected')
      } else if (file_ids.length === 0) {
        notify('error', 'Nothing matched that filter')
      } else {
        notify('success', `${file_ids.length} item${file_ids.length !== 1 ? 's' : ''} matched`)
      }
    } catch {
      notify('error', 'Failed to select by filter')
    } finally {
      setIsSelectingByFilter(false)
    }
  }

  // "Select all" in the toolbar means everything in the current view — which,
  // like the filter selection, spans pages that aren't loaded yet.
  async function selectAllInView() {
    setIsSelectingByFilter(true)
    try {
      const { file_ids, truncated } = await getMediaFileIds(folderId, { sort, hidden, filters })
      setSelectedIds(new Set(file_ids))
      setSelectionFilterChips([])
      if (truncated) notify('error', 'Too many items to select them all — the first 20,000 were selected')
    } catch {
      notify('error', 'Failed to select all')
    } finally {
      setIsSelectingByFilter(false)
    }
  }

  function handleFilterApply(applied: MediaFilters) {
    if (selectionMode) {
      selectByFilter(applied)
      return
    }
    setFilters(applied)
    setShowFilters(false)
  }

  const selectedIdList = useMemo(() => Array.from(selectedIds), [selectedIds])
  const selectedLoadedFiles = useMemo(
    () => files.filter((f) => selectedIds.has(f.id)),
    [files, selectedIds],
  )
  const allSelectedFavorited =
    selectedIdList.length > 0 && selectedIdList.every((id) => favoriteFileIds.has(id))

  // Runs a per-file action across the whole selection, then refreshes the grid
  // (and anything else the action touched) once at the end.
  async function runOnSelection(
    action: (id: string) => Promise<unknown>,
    describe: (n: number) => string,
    extraInvalidate?: () => void,
  ) {
    if (selectedIdList.length === 0) return
    setBulkPending(true)
    const failed = await runBatched(selectedIdList, action)
    const done = selectedIdList.length - failed
    setBulkPending(false)
    invalidate()
    extraInvalidate?.()
    if (failed > 0) notify('error', `${describe(done)}, ${failed} failed`)
    else notify('success', describe(done))
  }

  async function runBulkFavorite() {
    const shouldUnfavorite = allSelectedFavorited
    await runOnSelection(
      (id) => (shouldUnfavorite ? unfavoriteFile(id) : favoriteFile(id)),
      (n) => `${n} item${n !== 1 ? 's' : ''} ${shouldUnfavorite ? 'unfavorited' : 'favorited'}`,
      () => queryClient.invalidateQueries({ queryKey: favoritesQueryOptions.queryKey }),
    )
  }

  async function runBulkHidden(hide: boolean) {
    await runOnSelection(
      (id) => (hide ? hideFile(id) : unhideFile(id)),
      (n) => `${n} item${n !== 1 ? 's' : ''} ${hide ? 'hidden' : 'unhidden'}`,
    )
  }

  async function runBulkCopy(collectionId: string) {
    await runOnSelection(
      (id) => copyToCollection(collectionId, id),
      (n) => `${n} item${n !== 1 ? 's' : ''} added to collection`,
    )
  }

  async function runBulkRemove() {
    await runOnSelection(
      (id) => removeFromCollection(folderId, id),
      (n) => `${n} item${n !== 1 ? 's' : ''} removed from this collection`,
    )
    clearSelection()
  }

  async function runBulkDelete() {
    await runOnSelection(
      (id) => deleteFile(id),
      (n) => `${n} item${n !== 1 ? 's' : ''} deleted`,
      () => {
        queryClient.invalidateQueries({ queryKey: ['me'] })
        queryClient.invalidateQueries({ queryKey: ['storage', 'my-servers'] })
      },
    )
    setPendingBulkDelete(false)
    clearSelection()
  }

  const activeFilterCount = countMediaFilters(filters)

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
        <button
          onClick={() => setShowCollectionInfo(true)}
          className="text-gray-400 hover:text-gray-600 bg-transparent border-0 p-0.5 cursor-pointer"
          title="Collection info"
          aria-label="Collection info"
        >
          <MdInfoOutline className="text-lg" />
        </button>
        <button
          onClick={() => setControlsOpen(true)}
          aria-label="Open collection controls"
          className="lg:hidden inline-flex items-center justify-center w-9 h-9 shrink-0 rounded-lg border border-gray-200 text-gray-500 hover:text-gray-900 hover:bg-gray-100 cursor-pointer bg-white transition-colors ml-auto"
        >
          <MdMenu className="text-lg" />
        </button>
      </div>

      {/* Controls — a static wrapping toolbar at `lg` and up; below that it
          becomes a slide-in drawer (same pattern as the files page's side
          control panel), opened via the button in the header above. */}
      {controlsOpen && (
        <div
          onClick={() => setControlsOpen(false)}
          aria-hidden="true"
          className="lg:hidden fixed inset-0 z-[55] bg-black/40"
        />
      )}
      <div
        className={`fixed inset-y-0 left-0 z-[60] w-72 max-w-[80vw] overflow-y-auto bg-white p-4 shadow-xl transition-transform duration-200 ease-in-out flex flex-col gap-3 ${controlsOpen ? 'translate-x-0' : '-translate-x-full'} lg:static lg:z-auto lg:w-auto lg:max-w-none lg:translate-x-0 lg:overflow-visible lg:bg-transparent lg:p-0 lg:shadow-none lg:flex-row lg:flex-wrap lg:items-center lg:gap-2 mb-4`}
      >
        <div className="flex items-center justify-between mb-1 lg:hidden">
          <span className="text-sm font-semibold text-gray-900">Collection controls</span>
          <button
            onClick={() => setControlsOpen(false)}
            aria-label="Close collection controls"
            className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0.5"
          >
            <MdClose className="text-xl" />
          </button>
        </div>

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as MediaSort)}
          aria-label="Sort media"
          className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
        >
          <option value="taken_at">Date taken</option>
          <option value="created_at">Date uploaded</option>
          <option value="name">Name</option>
          <option value="source">Upload source</option>
        </select>

        <select
          value={cols}
          onChange={(e) => setCols(Number(e.target.value))}
          title="Items per row"
          aria-label="Items per row"
          className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
        >
          {colOptions.map((n) => (
            <option key={n} value={n}>{n} per row</option>
          ))}
        </select>

        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
          <ToggleBtn active={hidden === 'hide'} onClick={() => setHidden('hide')} label="Visible" />
          <ToggleBtn active={hidden === 'show'} onClick={() => setHidden('show')} label="Show hidden" />
          <ToggleBtn active={hidden === 'only'} onClick={() => setHidden('only')} label="Hidden" />
        </div>

        <button
          onClick={() => { setShowFilters(true); setControlsOpen(false) }}
          title={selectionMode ? 'Select items by filter' : 'Filter this collection'}
          className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs border rounded-lg cursor-pointer transition-colors ${
            activeFilterCount > 0
              ? 'bg-blue-50 text-blue-600 border-blue-200'
              : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
          }`}
        >
          <MdFilterAlt className="text-sm" /> Filter
          {activeFilterCount > 0 && (
            <span className="ml-0.5 inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-blue-600 text-white text-[10px] font-semibold">
              {activeFilterCount}
            </span>
          )}
        </button>

        <button
          onClick={toggleSelectionMode}
          title={selectionMode ? 'Exit selection mode' : 'Select multiple items'}
          className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs border rounded-lg cursor-pointer transition-colors ${
            selectionMode
              ? 'bg-blue-50 text-blue-600 border-blue-200'
              : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
          }`}
        >
          <MdChecklist className="text-sm" /> Select
        </button>

        {recognitionEnabled && (
          <button
            onClick={() => { setShowGroups(true); setControlsOpen(false) }}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs border border-amber-200 bg-amber-50 rounded-lg text-amber-700 hover:bg-amber-100 cursor-pointer transition-colors"
            title="Browse recognized people, pets, and objects"
          >
            <MdAutoAwesome className="text-sm" /> People &amp; pets
          </button>
        )}

        {!readOnly && (
          <>
            <button
              onClick={() => { setCreating(true); setNewName(''); setControlsOpen(false) }}
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
              onClick={() => { fileRef.current?.click(); setControlsOpen(false) }}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
            >
              <MdUploadFile className="text-sm" /> Upload
            </button>
          </>
        )}
      </div>

      {/* Active view filters (browsing) — one chip per facet, clearable. */}
      {activeFilterCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="text-xs text-gray-500">
            Filtered: {summarizeMediaFilters(filters, groupNames)}
          </span>
          <button
            onClick={() => setFilters(EMPTY_MEDIA_FILTERS)}
            className="text-xs text-blue-600 hover:text-blue-700 cursor-pointer bg-transparent border-0 p-0"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Filters a selection was built from — several union together. */}
      {selectionMode && selectionFilterChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          <span className="text-xs text-gray-400">Selected by:</span>
          {selectionFilterChips.map((chip) => (
            <span
              key={chip}
              className="inline-flex items-center px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-100 text-[11px]"
            >
              {chip}
            </span>
          ))}
        </div>
      )}

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

      {/* Media grid — virtualized: only rows near the viewport are rendered,
          with the container holding the full height of the rest. */}
      {files.length === 0 && !hasNextPage ? (
        <p className="text-sm text-gray-400 mt-4">
          {activeFilterCount > 0
            ? 'No media matches these filters.'
            : hidden === 'only' ? 'No hidden media.' : 'No media in this collection yet.'}
        </p>
      ) : (
        <div ref={attachGrid} className="relative" style={{ height: totalHeight }}>
          {visibleRows.map((row) => (
            <div
              key={row}
              className="absolute inset-x-0 grid gap-3"
              style={{
                top: row * stride,
                height: rowHeight,
                gridTemplateColumns: `repeat(${cols}, minmax(${MIN_TILE_PX}px, 1fr))`,
              }}
            >
              {Array.from({ length: cols }, (_, c) => row * cols + c)
                .filter((index) => index < files.length + placeholderCount)
                .map((index) => {
                  const f = files[index]
                  if (!f) return <MediaTilePlaceholder key={`placeholder-${index}`} />
                  return (
                    <MediaTile
                      key={f.id}
                      file={f}
                      readOnly={readOnly}
                      subcollections={subfolders}
                      isSubcollection={isSubcollection}
                      selectionMode={selectionMode}
                      selected={selectedIds.has(f.id)}
                      measureRef={index === firstRow * cols ? measureTile : undefined}
                      onToggleSelect={() => toggleSelect(f.id)}
                      onOpen={() => onOpenFile(f.id)}
                      onShowInfo={() => setInfoFile(f)}
                      onToggleHidden={() => hideMutation.mutate({ id: f.id, hide: !f.hidden })}
                      onCopy={(collectionId) => copyMutation.mutate({ collectionId, fileId: f.id })}
                      onRemove={() => removeMutation.mutate(f.id)}
                    />
                  )
                })}
            </div>
          ))}
        </div>
      )}

      {isFetchingNextPage && (
        <p className="mt-4 text-sm text-gray-400">Loading more…</p>
      )}

      {user && (
        <p className="text-xs text-gray-400 mt-6">Tip: enable auto-upload in your profile to send all photos and videos here.</p>
      )}

      {pendingFiles.length > 0 && user && !readOnly && (
        <UploadModal
          files={pendingFiles}
          folderName={folder.name}
          location={uploadDrive ? {
            name: uploadDrive.name,
            tier: uploadDrive.drive_type,
            isPinned: uploadDriveIsPinned,
            serverId: uploadDrive.server_id,
            usedBytes: uploadDrive.used_bytes,
            quotaBytes: uploadDrive.quota_bytes,
          } : undefined}
          user={user}
          onViewBreakdown={() => setShowStorageBreakdown(true)}
          onConfirm={() => {
            const filesToUpload = pendingFiles
            setPendingFiles([])
            startUpload(filesToUpload, folderId, onUploadSuccess)
          }}
          onCancel={() => setPendingFiles([])}
        />
      )}

      {showStorageBreakdown && (
        <StorageBreakdownModal
          servers={myServers ?? []}
          onClose={() => setShowStorageBreakdown(false)}
        />
      )}

      <UploadToast progress={progress} onDismiss={dismiss} onRetry={() => retryFailed(onUploadSuccess)} />

      {infoFile && <MediaInfoModal file={infoFile} devices={devicesData?.items} onClose={() => setInfoFile(null)} />}

      {showCollectionInfo && (
        <CollectionInfoModal
          folder={folder}
          isPremium={isPremium}
          readOnly={readOnly}
          onClose={() => setShowCollectionInfo(false)}
        />
      )}

      {showFilters && (
        <MediaFilterPanel
          collectionId={folderId}
          value={selectionMode ? EMPTY_MEDIA_FILTERS : filters}
          selectionMode={selectionMode}
          recognitionEnabled={recognitionEnabled}
          isApplying={isSelectingByFilter}
          selectedCount={selectedIds.size}
          onApply={handleFilterApply}
          onClose={() => setShowFilters(false)}
        />
      )}

      {selectionMode && (
        <MediaSelectionToolbar
          count={selectedIds.size}
          allFavorited={allSelectedFavorited}
          readOnly={readOnly}
          subcollections={subfolders}
          isSubcollection={isSubcollection}
          canSelectAll={files.length > 0}
          isWorking={bulkPending || isSelectingByFilter}
          onSelectAll={selectAllInView}
          onToggleFavorite={runBulkFavorite}
          onSetHidden={runBulkHidden}
          onCopyTo={runBulkCopy}
          onRemove={runBulkRemove}
          onDelete={() => setPendingBulkDelete(true)}
          onClose={clearSelection}
        />
      )}

      {pendingBulkDelete && (
        <BulkDeleteConfirmModal
          items={selectedLoadedFiles.map((f) => ({
            id: f.id, name: f.name, size_bytes: f.size_bytes, kind: 'file' as const,
          }))}
          unlistedCount={selectedIds.size - selectedLoadedFiles.length}
          username={user?.username ?? ''}
          usedBytes={user?.storage_used_bytes ?? 0}
          quotaBytes={user?.storage_quota_bytes ?? 0}
          isPending={bulkPending}
          onConfirm={runBulkDelete}
          onCancel={() => setPendingBulkDelete(false)}
        />
      )}

      {showGroups && (
        <RecognitionGroupsModal
          collectionId={folderId}
          initialGroupId={initialRecognitionGroup}
          onOpenFile={onOpenFile}
          onClose={() => setShowGroups(false)}
        />
      )}

      {activeFileId && (
        files.some((f) => f.id === activeFileId) ? (
          <MediaViewerPage
            files={files}
            activeFileId={activeFileId}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            onFetchNextPage={fetchNextPage}
            favoriteFileIds={favoriteFileIds}
            onToggleFavorite={toggleFavoriteFile}
            onNavigate={onNavigateFile}
            onClose={onCloseFile}
          />
        ) : (
          <div className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center gap-3 text-white">
            <p className="text-sm text-white/70">
              {isLoading || isFetchingNextPage ? 'Loading…' : 'That item isn’t in the current view (try clearing filters).'}
            </p>
            <button
              onClick={onCloseFile}
              className="px-4 py-2 text-sm rounded-lg border border-white/30 text-white hover:bg-white/10 cursor-pointer transition-colors"
            >
              Back to collection
            </button>
          </div>
        )
      )}
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

// MediaTilePlaceholder stands in for an item on a page that hasn't arrived
// yet. It occupies exactly one grid cell so the row (and the scroll height
// the grid reserves for it) is identical whether or not the data is in.
function MediaTilePlaceholder() {
  return (
    <div
      aria-hidden="true"
      className="rounded-lg border border-gray-200 bg-gray-50 overflow-hidden animate-pulse"
    >
      <div className="w-full aspect-square bg-gray-100" />
      <div className="px-2 py-1.5 flex flex-col gap-1">
        <div className="h-2 rounded bg-gray-200 w-3/4" />
        <div className="h-2 rounded bg-gray-100 w-1/2" />
      </div>
    </div>
  )
}

function MediaTile({
  file,
  readOnly,
  subcollections,
  isSubcollection,
  selectionMode,
  selected,
  measureRef,
  onToggleSelect,
  onOpen,
  onShowInfo,
  onToggleHidden,
  onCopy,
  onRemove,
}: {
  file: File
  readOnly: boolean
  subcollections: Folder[]
  isSubcollection: boolean
  selectionMode: boolean
  selected: boolean
  // Set on one tile per render so the grid can measure a real tile's height
  // and reserve exactly that much room for the rows it doesn't render.
  measureRef?: (el: HTMLDivElement | null) => void
  onToggleSelect: () => void
  onOpen: () => void
  onShowInfo: () => void
  onToggleHidden: () => void
  onCopy: (collectionId: string) => void
  onRemove: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const isImage = file.mime_type.startsWith('image/')
  const isVideo = file.mime_type.startsWith('video/')
  const dateLabel = file.taken_at ?? file.created_at

  return (
    <div
      ref={measureRef}
      className={`relative group rounded-lg overflow-hidden border bg-gray-50 ${file.hidden ? 'opacity-60' : ''} ${
        selected ? 'border-blue-500 ring-2 ring-blue-500' : 'border-gray-200'
      }`}
    >
      <button
        onClick={selectionMode ? onToggleSelect : onOpen}
        className="block w-full aspect-square bg-gray-100 cursor-pointer border-0 p-0 m-0"
        title={file.name}
      >
        {isImage ? (
          <RetryImg src={previewUrl(file.id)} alt={file.name} loading="lazy" className="w-full h-full object-cover" />
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

      {file.hidden && !selectionMode && (
        <span className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded">Hidden</span>
      )}

      {selectionMode && (
        <button
          onClick={onToggleSelect}
          aria-label={selected ? 'Deselect item' : 'Select item'}
          className="absolute top-1 left-1 bg-white/90 hover:bg-white rounded p-0.5 cursor-pointer border-0 shadow-sm leading-none"
        >
          {selected
            ? <MdCheckBox className="text-lg text-blue-600" />
            : <MdCheckBoxOutlineBlank className="text-lg text-gray-400" />}
        </button>
      )}

      {/* Visible by default (touch devices below `sm` have no hover state to
          reveal these on); from `sm` up, fade in on hover/focus so the grid
          stays visually quiet on pointer-driven layouts. Hidden entirely in
          selection mode, where a tap means "select". */}
      {!selectionMode && (
        <div className="absolute top-1 right-1 flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
          <button
            onClick={onShowInfo}
            title="File info"
            className="bg-white/90 hover:bg-white rounded p-1 cursor-pointer border-0 text-gray-600 shadow-sm"
          >
            <MdInfoOutline className="text-sm" />
          </button>
          {!readOnly && (
            <>
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
            </>
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

// ── Metadata viewer ───────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

// uploadSourceLabel turns a file's device_id/source into a human-readable
// origin. A registered device (mobile app upload/sync) takes priority since
// it's the most specific signal; otherwise falls back to the source string.
function uploadSourceLabel(file: File, devices: Device[] | undefined): string {
  if (file.device_id) {
    const device = devices?.find((d) => d.id === file.device_id)
    if (device) {
      const platform = device.platform === 'ios' ? 'iOS' : device.platform === 'android' ? 'Android' : device.platform
      return `${device.name} (${platform} app)`
    }
    return 'Mobile app (device removed)'
  }
  switch (file.source) {
    case 'google_drive':
      return 'Google Drive backup'
    case 'google_photos':
      return 'Google Photos backup'
    case 'email_backup_gmail':
      return 'Gmail backup'
    case 'email_backup_microsoft':
      return 'Microsoft email backup'
    case 'file_server':
      return 'File Server (WebDAV)'
    case 'device':
      return 'Mobile app'
    case 'web':
    default:
      return 'Web upload'
  }
}

// MediaInfoModal shows a media file's metadata: capture date (EXIF/container,
// as extracted server-side into taken_at), upload/modified dates, type, size,
// visibility, origin, and — measured from the loaded preview — pixel dimensions.
function MediaInfoModal({ file, devices, onClose }: { file: File; devices?: Device[]; onClose: () => void }) {
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null)
  const isImage = file.mime_type.startsWith('image/')
  const isVideo = file.mime_type.startsWith('video/')

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-96 max-w-[92vw] max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900 m-0 truncate pr-3" title={file.name}>{file.name}</h3>
          <button
            onClick={onClose}
            aria-label="Close info"
            className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0 shrink-0"
          >
            <MdClose className="text-lg" />
          </button>
        </div>

        {isImage && (
          <RetryImg
            src={previewUrl(file.id)}
            alt={file.name}
            onLoad={(e) => setDimensions({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            className="w-full max-h-56 object-contain bg-gray-50"
          />
        )}
        {isVideo && (
          <video
            src={streamUrl(file.id)}
            onLoadedMetadata={(e) => setDimensions({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
            muted
            preload="metadata"
            className="w-full max-h-56 object-contain bg-gray-50"
          />
        )}

        <dl className="m-0 px-5 py-2 divide-y divide-gray-50">
          <InfoRow label="Date taken" value={file.taken_at ? new Date(file.taken_at).toLocaleString() : 'Not available'} muted={!file.taken_at} />
          <InfoRow label="Uploaded" value={new Date(file.created_at).toLocaleString()} />
          <InfoRow label="Uploaded from" value={uploadSourceLabel(file, devices)} />
          <InfoRow label="Modified" value={new Date(file.updated_at).toLocaleString()} />
          <InfoRow label="Type" value={file.mime_type} />
          <InfoRow label="Size" value={formatBytes(file.size_bytes)} />
          {(isImage || isVideo) && (
            <InfoRow label="Dimensions" value={dimensions ? `${dimensions.w} × ${dimensions.h} px` : 'Measuring…'} muted={!dimensions} />
          )}
          <InfoRow label="Visibility" value={file.hidden ? 'Hidden from collection' : 'Visible'} />
        </dl>
      </div>
    </div>
  )
}

function InfoRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <dt className="text-xs text-gray-500 m-0 shrink-0">{label}</dt>
      <dd className={`text-xs m-0 text-right break-all ${muted ? 'text-gray-400' : 'text-gray-800 font-medium'}`}>{value}</dd>
    </div>
  )
}
