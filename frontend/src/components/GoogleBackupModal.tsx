import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MdCheck,
  MdChevronRight,
  MdCloud,
  MdDeleteOutline,
  MdExpandMore,
  MdFilePresent,
  MdFolder,
  MdImage,
  MdInfo,
  MdMusicNote,
  MdPhotoLibrary,
  MdSettings,
  MdVideoLibrary,
  MdClose,
} from 'react-icons/md'
import { listRoot } from '../api/folders'
import type { Folder } from '../types/api'
import {
  deleteGoogleDriveFile,
  drivePreviewUrl,
  photosPreviewBlobUrl,
  uploadGoogleEntries,
  loadBackupBackground,
  saveBackupBackground,
  type BackupEntry,
  type BackupItemStatus,
  type BackupResult,
  type GoogleBackupItem,
} from '../api/googleBackup'

// ── Types ──────────────────────────────────────────────────────────────────────

interface FileEntry {
  googleItem: GoogleBackupItem
  name: string
  type: string
  size: number
  source: 'drive' | 'photos'
  destFolderId: string | null
}

type SortMode = 'type' | 'size' | 'name'
type Category = 'Photos' | 'Images' | 'Videos' | 'Audio' | 'Documents' | 'Other'
type DestTarget = { kind: 'file'; index: number } | { kind: 'category'; category: Category }

interface ListItem { entry: FileEntry; index: number }
interface Section  { title: Category; items: ListItem[] }

interface Props {
  items: GoogleBackupItem[]
  accessToken: string
  quotaBytes: number
  usedBytes: number
  redirectFolderName: string | null
  onClose: () => void
  onDone: () => void
  onStartBackground: (entries: BackupEntry[], token: string) => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CATEGORY_ORDER: Category[] = ['Photos', 'Images', 'Videos', 'Audio', 'Documents', 'Other']

function getCategory(e: FileEntry): Category {
  if (e.source === 'photos') return 'Photos'
  const m = e.type
  if (m.startsWith('image/'))  return 'Images'
  if (m.startsWith('video/'))  return 'Videos'
  if (m.startsWith('audio/'))  return 'Audio'
  if (m.startsWith('text/') || m.startsWith('application/') || e.googleItem.isGoogleDoc) return 'Documents'
  return 'Other'
}

function isMediaEntry(e: FileEntry): boolean {
  return e.type.startsWith('image/') || e.type.startsWith('video/')
}

function fmt(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3)   return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function FileTypeIcon({ entry, className }: { entry: FileEntry; className?: string }) {
  if (entry.source === 'photos' || entry.type.startsWith('image/'))
    return <MdImage className={className} />
  if (entry.type.startsWith('video/'))  return <MdVideoLibrary className={className} />
  if (entry.type.startsWith('audio/'))  return <MdMusicNote className={className} />
  return <MdFilePresent className={className} />
}

// ── Component ─────────────────────────────────────────────────────────────────

export function GoogleBackupModal({
  items, accessToken, quotaBytes, usedBytes, redirectFolderName,
  onClose, onDone, onStartBackground,
}: Props) {
  const [entries,   setEntries]   = useState<FileEntry[]>([])
  const [selected,  setSelected]  = useState<Set<number>>(new Set())
  const [sort,      setSort]      = useState<SortMode>('type')
  const [tab,       setTab]       = useState<'files' | 'settings'>('files')
  const [collapsed, setCollapsed] = useState<Set<Category>>(new Set())
  const [folders,   setFolders]   = useState<Folder[]>([])
  const [foldersLoading, setFoldersLoading] = useState(false)
  const [destTarget, setDestTarget] = useState<DestTarget | null>(null)
  const [destAnchor, setDestAnchor] = useState<{ x: number; y: number } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [progress,  setProgress]  = useState<{ done: number; total: number } | null>(null)
  const [result,    setResult]    = useState<BackupResult | null>(null)
  const [statusMap, setStatusMap] = useState<Record<number, BackupItemStatus>>({})
  const [finished,  setFinished]  = useState(false)
  const [cleanupLoading, setCleanupLoading] = useState(false)
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null)
  const [bgEnabled, setBgEnabled] = useState(true)
  const [previewItem, setPreviewItem] = useState<FileEntry | null>(null)
  const [previewUrl,  setPreviewUrl]  = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const previewBlobRef = useRef<string | null>(null)

  // Reset on open
  useEffect(() => {
    if (items.length === 0) return
    const mapped: FileEntry[] = items.map((g) => ({
      googleItem:   g,
      name:         g.isGoogleDoc ? `${g.name}.pdf` : g.name,
      type:         g.isGoogleDoc ? 'application/pdf' : g.mimeType,
      size:         g.size ?? 0,
      source:       g.source,
      destFolderId: null,
    }))
    setEntries(mapped)
    setSelected(new Set(mapped.map((_, i) => i)))
    setSort('type')
    setTab('files')
    setCollapsed(new Set())
    setDestTarget(null)
    setDestAnchor(null)
    setUploading(false)
    setProgress(null)
    setResult(null)
    setStatusMap({})
    setFinished(false)
    setCleanupLoading(false)
    setCleanupMsg(null)
    setBgEnabled(loadBackupBackground())
    setPreviewItem(null)
    setPreviewUrl(null)
  }, [items])

  useEffect(() => {
    setFoldersLoading(true)
    listRoot({ folderLimit: 100, fileLimit: 0 })
      .then((c) => setFolders(c.subfolders?.items ?? []))
      .catch(() => setFolders([]))
      .finally(() => setFoldersLoading(false))
  }, [])

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (previewItem) { closePreview(); return }
        if (destTarget)  { setDestTarget(null); setDestAnchor(null); return }
        if (!finished) onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [previewItem, destTarget, finished, onClose])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  // ── Preview ────────────────────────────────────────────────────────────────

  async function openPreview(entry: FileEntry) {
    setPreviewItem(entry)
    setPreviewUrl(null)
    setPreviewLoading(true)
    let url: string | null = null
    if (entry.source === 'drive') {
      url = drivePreviewUrl(entry.googleItem)
    } else {
      url = await photosPreviewBlobUrl(entry.googleItem, accessToken)
      if (url) previewBlobRef.current = url
    }
    setPreviewUrl(url)
    setPreviewLoading(false)
  }

  function closePreview() {
    setPreviewItem(null)
    setPreviewUrl(null)
    if (previewBlobRef.current) {
      URL.revokeObjectURL(previewBlobRef.current)
      previewBlobRef.current = null
    }
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  const toggle = (i: number) =>
    setSelected((prev) => { const s = new Set(prev); s.has(i) ? s.delete(i) : s.add(i); return s })

  const toggleGroup = (indices: number[]) => {
    const allOn = indices.every((i) => selected.has(i))
    setSelected((prev) => {
      const s = new Set(prev)
      indices.forEach((i) => (allOn ? s.delete(i) : s.add(i)))
      return s
    })
  }

  const allSelected = selected.size === entries.length

  // ── Destinations ──────────────────────────────────────────────────────────

  function openDest(target: DestTarget, anchor: { x: number; y: number }) {
    setDestTarget(target)
    setDestAnchor(anchor)
  }

  function applyDest(folderId: string | null) {
    if (!destTarget) return
    if (destTarget.kind === 'file') {
      const idx = destTarget.index
      setEntries((prev) => prev.map((e, j) => (j === idx ? { ...e, destFolderId: folderId } : e)))
    } else {
      const cat = destTarget.category
      setEntries((prev) => prev.map((e) => (getCategory(e) === cat ? { ...e, destFolderId: folderId } : e)))
    }
    setDestTarget(null)
    setDestAnchor(null)
  }

  const folderLabel = (id: string | null) =>
    id ? (folders.find((f) => f.id === id)?.name ?? '/ Root') : '/ Root'

  const activeDest = (() => {
    if (!destTarget) return undefined
    if (destTarget.kind === 'file') return entries[destTarget.index]?.destFolderId
    const cat = destTarget.category
    const catEntries = entries.filter((e) => getCategory(e) === cat)
    const first = catEntries[0]?.destFolderId ?? null
    return catEntries.every((e) => (e.destFolderId ?? null) === first) ? first : undefined
  })()

  // ── Quota ──────────────────────────────────────────────────────────────────

  const selectedSize = useMemo(
    () => entries.filter((_, i) => selected.has(i)).reduce((s, e) => s + e.size, 0),
    [entries, selected],
  )
  const projectedUsed = usedBytes + selectedSize
  const isOverQuota   = quotaBytes > 0 && projectedUsed > quotaBytes
  const overflowBytes = isOverQuota ? projectedUsed - quotaBytes : 0
  const usedPct  = quotaBytes > 0 ? Math.min((usedBytes / quotaBytes) * 100, 100) : 0
  const fitsPct  = quotaBytes > 0
    ? (Math.max(0, Math.min(selectedSize, quotaBytes - usedBytes)) / quotaBytes) * 100
    : 0
  const overflowPct = isOverQuota ? Math.max(0, 100 - usedPct - fitsPct) : 0

  // ── Sorted / grouped data ──────────────────────────────────────────────────

  const sections: Section[] = useMemo(() => {
    const map = new Map<Category, ListItem[]>(CATEGORY_ORDER.map((c) => [c, []]))
    entries.forEach((entry, index) => map.get(getCategory(entry))!.push({ entry, index }))
    return CATEGORY_ORDER
      .filter((c) => map.get(c)!.length > 0)
      .map((c) => ({ title: c, items: map.get(c)! }))
  }, [entries])

  const flatList: ListItem[] = useMemo(() => {
    const indexed = entries.map((entry, index) => ({ entry, index }))
    if (sort === 'size') return [...indexed].sort((a, b) => b.entry.size - a.entry.size)
    if (sort === 'name') return [...indexed].sort((a, b) => a.entry.name.localeCompare(b.entry.name))
    return indexed
  }, [entries, sort])

  // ── Upload ─────────────────────────────────────────────────────────────────

  async function handleBackUp() {
    const toUpload = entries.filter((_, i) => selected.has(i))
    if (toUpload.length === 0) return

    if (bgEnabled) {
      onStartBackground(toUpload, accessToken)
      return
    }

    setUploading(true)
    setStatusMap({})
    setProgress({ done: 0, total: toUpload.length })
    const res = await uploadGoogleEntries(toUpload, accessToken, (done, total, fin) => {
      setProgress({ done, total })
      if (fin) {
        const idx = entries.indexOf(fin.entry as FileEntry)
        if (idx >= 0) setStatusMap((m) => ({ ...m, [idx]: fin.status }))
      }
    })
    setResult(res)
    setUploading(false)
    setFinished(true)
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  async function handleCleanup() {
    const driveEntries = entries.filter((e) => e.source === 'drive')
    const photoCount   = entries.filter((e) => e.source === 'photos').length
    const driveCount   = driveEntries.length

    if (driveCount === 0) {
      setCleanupMsg(
        `Google does not allow third-party apps to delete Google Photos. ` +
        `Open the Google Photos app to remove ${photoCount} photo${photoCount !== 1 ? 's' : ''} manually.`,
      )
      return
    }

    const photosNote = photoCount > 0
      ? ` (${photoCount} Google Photo${photoCount !== 1 ? 's' : ''} cannot be deleted via API — remove them manually.)`
      : ''

    const confirmed = window.confirm(
      `Move ${driveCount} Drive file${driveCount !== 1 ? 's' : ''} to your Google Drive trash? ` +
      `They are safely backed up in Apollo SFS.${photosNote}`,
    )
    if (!confirmed) return

    setCleanupLoading(true)
    let failed = 0
    for (const e of driveEntries) {
      try { await deleteGoogleDriveFile(e.googleItem.id, accessToken) }
      catch { failed++ }
    }
    setCleanupLoading(false)
    const resultMsg = failed === 0
      ? `${driveCount} file${driveCount !== 1 ? 's' : ''} moved to Google Drive trash.${photosNote}`
      : `${driveCount - failed} of ${driveCount} moved to trash. ${failed} failed.${photosNote}`
    setCleanupMsg(resultMsg)
  }

  // ── Derived UI state ───────────────────────────────────────────────────────

  const canBackUp  = selected.size > 0 && !isOverQuota && !uploading
  const showByType = sort === 'type' && !finished
  const listData   = finished ? entries.map((entry, index) => ({ entry, index })) : flatList
  const driveCount = entries.filter((e) => e.source === 'drive').length
  const photoCount = entries.filter((e) => e.source === 'photos').length
  const showTabs   = !finished && !uploading

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div
        className="bg-white rounded-xl shadow-2xl flex flex-col"
        style={{ width: 680, maxWidth: '96vw', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0">
          <button
            onClick={finished ? onDone : onClose}
            className="p-1 rounded hover:bg-gray-100 text-gray-500 cursor-pointer transition-colors"
          >
            <MdClose className="text-xl" />
          </button>
          <span className="text-sm font-semibold text-gray-900">Google Backup</span>
          {!finished ? (
            <button
              onClick={() => setSelected(allSelected ? new Set() : new Set(entries.map((_, i) => i)))}
              className="text-xs font-semibold text-blue-600 hover:text-blue-700 cursor-pointer px-1"
            >
              {allSelected ? 'None' : 'All'}
            </button>
          ) : <div className="w-10" />}
        </div>

        {/* Tab bar */}
        {showTabs && (
          <div className="flex gap-1 px-4 py-2 border-b border-gray-200 shrink-0">
            {(['files', 'settings'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-colors ${
                  tab === t ? 'bg-blue-50 text-blue-600' : 'text-gray-500 hover:bg-gray-50'
                }`}
              >
                {t === 'settings' && <MdSettings className="text-sm" />}
                {t === 'files' ? 'Files' : 'Settings'}
              </button>
            ))}
          </div>
        )}

        {tab === 'settings' ? (
          // ── Settings tab ──────────────────────────────────────────────────
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <div className="flex items-center justify-between bg-gray-50 rounded-lg p-4">
              <div className="flex-1 mr-4">
                <div className="text-sm font-semibold text-gray-900">Back up in the background</div>
                <div className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                  Close this window when you start a backup and keep uploading, with progress shown in the toolbar.
                </div>
              </div>
              <label className="relative inline-flex cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={bgEnabled}
                  onChange={(e) => { setBgEnabled(e.target.checked); saveBackupBackground(e.target.checked) }}
                />
                <div className="w-10 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:start-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
              </label>
            </div>
          </div>
        ) : (
          // ── Files tab ──────────────────────────────────────────────────────
          <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
            {/* Quota card */}
            {quotaBytes > 0 && (
              <div className="mx-4 mt-3 p-3 bg-gray-50 rounded-lg border border-gray-100 shrink-0">
                <div className="flex justify-between items-center text-xs mb-1.5">
                  <span className="font-semibold text-gray-700">
                    {selected.size} of {entries.length} file{entries.length !== 1 ? 's' : ''} selected
                  </span>
                  <span className={isOverQuota ? 'font-semibold text-red-500' : 'text-gray-500'}>
                    {fmt(selectedSize)}
                  </span>
                </div>
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden flex">
                  <div className="h-full bg-blue-500/40 transition-all" style={{ width: `${usedPct}%` }} />
                  <div
                    className="h-full transition-all"
                    style={{
                      width: `${fitsPct}%`,
                      backgroundColor: isOverQuota ? '#ef4444' : '#3b82f6',
                    }}
                  />
                  {isOverQuota && overflowPct > 0 && (
                    <div className="h-full bg-red-300" style={{ width: `${overflowPct}%` }} />
                  )}
                </div>
                <div className="flex justify-between text-[10px] text-gray-400 mt-1">
                  <span>After: {fmt(projectedUsed)}</span>
                  <span>Quota: {fmt(quotaBytes)}</span>
                </div>
                {photoCount > 0 && (
                  <p className="text-[10px] text-gray-400 italic mt-0.5">
                    * Google Photos sizes are not reported by the API and are excluded from the estimate.
                  </p>
                )}
              </div>
            )}

            {/* Over-quota strip */}
            {isOverQuota && (
              <div className="mx-4 mt-2 flex items-center gap-2 bg-red-500 text-white rounded-lg px-3 py-2 text-xs shrink-0">
                <span className="flex-1 font-medium">{fmt(overflowBytes)} over quota</span>
                <a href="/premium" className="font-bold underline">Get more storage →</a>
              </div>
            )}

            {/* Photo redirect notice */}
            {redirectFolderName !== null && (
              <div className="mx-4 mt-2 flex items-center gap-2 bg-purple-50 text-purple-600 rounded-lg px-3 py-2 text-xs shrink-0">
                <MdPhotoLibrary className="shrink-0" />
                <span>Photos &amp; videos will be saved to &ldquo;{redirectFolderName}&rdquo; (auto-upload folder)</span>
              </div>
            )}

            {/* Sort bar */}
            {!finished && (
              <div className="flex items-center gap-2 px-4 pt-3 pb-1 shrink-0">
                <span className="text-xs text-gray-400">Sort by</span>
                {(['type', 'size', 'name'] as SortMode[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSort(s)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium cursor-pointer transition-colors ${
                      sort === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>
            )}

            {/* File list */}
            <div className="flex-1 overflow-y-auto min-h-0">
              {showByType ? (
                sections.map((section) => {
                  const indices   = section.items.map((d) => d.index)
                  const selCount  = indices.filter((i) => selected.has(i)).length
                  const allGroupOn = section.items.length > 0 && selCount === section.items.length
                  const isCollapsed = collapsed.has(section.title)
                  const catRedirected = redirectFolderName !== null && section.items.every((d) => isMediaEntry(d.entry))

                  return (
                    <div key={section.title}>
                      {/* Section header */}
                      <div className="flex items-center justify-between px-4 py-1.5 bg-gray-50 border-y border-gray-100 sticky top-0 z-10">
                        <button
                          onClick={() => setCollapsed((prev) => { const s = new Set(prev); s.has(section.title) ? s.delete(section.title) : s.add(section.title); return s })}
                          className="flex items-center gap-1 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700"
                        >
                          {isCollapsed
                            ? <MdChevronRight className="text-sm" />
                            : <MdExpandMore className="text-sm" />}
                          {section.title}
                        </button>
                        <div className="flex items-center gap-2">
                          {!finished && !catRedirected && (
                            <button
                              onClick={(e) => openDest({ kind: 'category', category: section.title }, { x: e.clientX, y: e.clientY })}
                              className="flex items-center gap-1 text-[10px] font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded cursor-pointer hover:bg-blue-100 transition-colors"
                            >
                              <MdFolder className="text-xs" /> Folder
                            </button>
                          )}
                          {!finished && (
                            <button
                              onClick={() => toggleGroup(indices)}
                              className="text-xs text-blue-600 font-medium cursor-pointer hover:text-blue-700"
                            >
                              {selCount}/{section.items.length} {allGroupOn ? 'Deselect all' : 'Select all'}
                            </button>
                          )}
                          {finished && (
                            <span className="text-xs text-gray-400">{selCount}/{section.items.length}</span>
                          )}
                        </div>
                      </div>
                      {/* Section rows */}
                      {!isCollapsed && section.items.map(({ entry, index }) =>
                        <FileRow
                          key={index}
                          entry={entry}
                          index={index}
                          checked={selected.has(index)}
                          status={statusMap[index]}
                          redirectFolderName={redirectFolderName}
                          folderLabel={folderLabel}
                          uploading={uploading}
                          finished={finished}
                          onToggle={toggle}
                          onOpenDest={openDest}
                          onPreview={() => openPreview(entry)}
                        />
                      )}
                    </div>
                  )
                })
              ) : (
                listData.map(({ entry, index }) => (
                  <FileRow
                    key={index}
                    entry={entry}
                    index={index}
                    checked={selected.has(index)}
                    status={statusMap[index]}
                    redirectFolderName={redirectFolderName}
                    folderLabel={folderLabel}
                    uploading={uploading}
                    finished={finished}
                    onToggle={toggle}
                    onOpenDest={openDest}
                    onPreview={() => openPreview(entry)}
                  />
                ))
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="border-t border-gray-200 px-4 py-3 flex flex-col gap-2 shrink-0">
          {/* Upload progress */}
          {uploading && progress && (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 rounded-full transition-all"
                  style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                />
              </div>
              <span className="text-xs text-gray-500 shrink-0">{progress.done} / {progress.total}</span>
            </div>
          )}

          {/* Result summary */}
          {finished && result && (
            <p className={`text-xs text-center ${result.errors > 0 ? 'text-amber-600' : 'text-green-600'}`}>
              {[
                `${result.uploaded} backed up`,
                result.duplicates > 0 ? `${result.duplicates} duplicate${result.duplicates !== 1 ? 's' : ''}` : null,
                result.errors > 0 ? `${result.errors} failed` : null,
              ].filter(Boolean).join(' · ')}
            </p>
          )}

          {/* Cleanup message */}
          {cleanupMsg && (
            <p className="text-xs text-gray-500 text-center">{cleanupMsg}</p>
          )}

          {/* Cleanup button */}
          {finished && !cleanupMsg && (
            <button
              onClick={handleCleanup}
              disabled={cleanupLoading}
              className={`flex items-center justify-center gap-1.5 text-sm py-2 rounded-lg border transition-colors cursor-pointer disabled:opacity-50 ${
                driveCount > 0
                  ? 'border-red-300 text-red-500 hover:bg-red-50'
                  : 'border-gray-200 text-gray-500 hover:bg-gray-50'
              }`}
            >
              {cleanupLoading ? (
                <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              ) : driveCount > 0 ? (
                <><MdDeleteOutline className="text-base" /> Delete {driveCount} Drive file{driveCount !== 1 ? 's' : ''} from Google</>
              ) : (
                <><MdInfo className="text-base" /> {photoCount} photo{photoCount !== 1 ? 's' : ''} — delete manually in Google Photos</>
              )}
            </button>
          )}

          {/* Primary action button */}
          {finished ? (
            <button
              onClick={onDone}
              className="flex items-center justify-center gap-2 py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-lg cursor-pointer transition-colors"
            >
              <MdCheck className="text-base" /> Done
            </button>
          ) : (
            <button
              onClick={handleBackUp}
              disabled={!canBackUp}
              className="flex items-center justify-center gap-2 py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-lg cursor-pointer transition-colors disabled:opacity-40"
            >
              {uploading ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <MdCloud className="text-base" />
                  {isOverQuota
                    ? 'Over quota — deselect files or upgrade'
                    : selected.size === 0
                      ? 'No files selected'
                      : `Back Up ${selected.size} File${selected.size !== 1 ? 's' : ''}`}
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Destination picker dropdown */}
      {destTarget && destAnchor && (
        <DestPicker
          anchor={destAnchor}
          folders={folders}
          loading={foldersLoading}
          activeDest={activeDest}
          label={destTarget.kind === 'category' ? `Destination for all ${destTarget.category}` : 'Choose destination'}
          onSelect={applyDest}
          onClose={() => { setDestTarget(null); setDestAnchor(null) }}
        />
      )}

      {/* Image preview */}
      {previewItem && (
        <div
          className="fixed inset-0 bg-black/90 z-[60] flex items-center justify-center"
          onClick={closePreview}
        >
          <button
            className="absolute top-4 right-4 text-white p-2 hover:bg-white/10 rounded-lg cursor-pointer transition-colors"
            onClick={closePreview}
          >
            <MdClose className="text-2xl" />
          </button>
          {previewLoading && (
            <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
          )}
          {previewUrl && !previewLoading && (
            <img
              src={previewUrl}
              alt={previewItem.name}
              className="max-w-[90vw] max-h-[85vh] object-contain rounded"
              onClick={(e) => e.stopPropagation()}
            />
          )}
          {!previewUrl && !previewLoading && (
            <p className="text-white text-sm">Preview not available</p>
          )}
          <p className="absolute bottom-6 left-0 right-0 text-center text-white text-sm px-8 truncate">
            {previewItem.name}
          </p>
        </div>
      )}
    </div>
  )
}

// ── File row ───────────────────────────────────────────────────────────────────

interface FileRowProps {
  entry: FileEntry
  index: number
  checked: boolean
  status: BackupItemStatus | undefined
  redirectFolderName: string | null
  folderLabel: (id: string | null) => string
  uploading: boolean
  finished: boolean
  onToggle: (i: number) => void
  onOpenDest: (target: DestTarget, anchor: { x: number; y: number }) => void
  onPreview: () => void
}

function FileRow({
  entry, index, checked, status, redirectFolderName, folderLabel,
  uploading, finished, onToggle, onOpenDest, onPreview,
}: FileRowProps) {
  const isDrive  = entry.source === 'drive'
  const locked   = redirectFolderName !== null && isMediaEntry(entry)
  const canPreviewItem = !finished && (
    (isDrive && entry.googleItem.thumbnailLink && entry.type.startsWith('image/')) ||
    (!isDrive && entry.googleItem.baseUrl && entry.type.startsWith('image/'))
  )

  return (
    <div
      className={`flex items-center gap-2.5 px-4 py-2 border-b border-gray-50 hover:bg-gray-50/50 transition-colors ${
        !checked ? 'opacity-50' : ''
      }`}
    >
      {/* Checkbox */}
      <button
        onClick={() => !uploading && !finished && onToggle(index)}
        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 cursor-pointer transition-colors ${
          checked ? 'bg-blue-600 border-blue-600' : 'border-gray-300'
        }`}
        disabled={uploading || finished}
      >
        {checked && <MdCheck className="text-white text-xs" />}
      </button>

      {/* File type icon */}
      <button
        onClick={() => canPreviewItem && onPreview()}
        className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors ${
          isDrive ? 'bg-blue-50' : 'bg-red-50'
        } ${canPreviewItem ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
        tabIndex={canPreviewItem ? 0 : -1}
      >
        <FileTypeIcon
          entry={entry}
          className={`text-base ${isDrive ? 'text-blue-500' : 'text-red-400'}`}
        />
      </button>

      {/* Name + meta */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900 truncate">{entry.name}</div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
            isDrive ? 'bg-blue-50 text-blue-600' : 'bg-red-50 text-red-500'
          }`}>
            {isDrive ? 'Drive' : 'Photos'}
          </span>
          <span className="text-xs text-gray-400">{entry.size > 0 ? fmt(entry.size) : '—'}</span>
        </div>
      </div>

      {/* Status or destination */}
      {status ? (
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${
          status === 'done'      ? 'bg-green-100 text-green-700'
          : status === 'duplicate' ? 'bg-amber-100 text-amber-700'
          : 'bg-red-100 text-red-600'
        }`}>
          {status === 'done' ? 'Backed up' : status === 'duplicate' ? 'Duplicate' : 'Failed'}
        </span>
      ) : locked ? (
        <span className="flex items-center gap-1 text-[10px] font-medium text-purple-600 bg-purple-50 px-2 py-0.5 rounded shrink-0 max-w-[100px] truncate">
          <MdPhotoLibrary className="text-xs shrink-0" />
          <span className="truncate">{redirectFolderName}</span>
        </span>
      ) : (
        <button
          onClick={(e) => checked && !uploading && !finished && onOpenDest({ kind: 'file', index }, { x: e.clientX, y: e.clientY })}
          disabled={!checked || uploading || finished}
          className="flex items-center gap-0.5 text-[11px] font-medium text-blue-600 bg-blue-50 px-2 py-0.5 rounded cursor-pointer hover:bg-blue-100 disabled:opacity-35 disabled:cursor-default transition-colors shrink-0 max-w-[110px]"
        >
          <span className="truncate">{folderLabel(entry.destFolderId)}</span>
          <MdExpandMore className="text-xs shrink-0" />
        </button>
      )}
    </div>
  )
}

// ── Destination picker ─────────────────────────────────────────────────────────

interface DestPickerProps {
  anchor: { x: number; y: number }
  folders: Folder[]
  loading: boolean
  activeDest: string | null | undefined
  label: string
  onSelect: (folderId: string | null) => void
  onClose: () => void
}

function DestPicker({ anchor, folders, loading, activeDest, label, onSelect, onClose }: DestPickerProps) {
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // Position: try to fit below click point, flip up if needed
  const style: React.CSSProperties = {
    position: 'fixed',
    zIndex: 60,
    left: Math.min(anchor.x, window.innerWidth - 280),
    top: anchor.y + 8,
    maxHeight: 320,
    width: 260,
  }
  if (anchor.y + 330 > window.innerHeight) {
    style.top = undefined
    style.bottom = window.innerHeight - anchor.y + 8
  }

  return (
    <div
      ref={ref}
      style={style}
      className="bg-white rounded-xl shadow-xl border border-gray-200 flex flex-col overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-gray-100 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
        {label}
      </div>
      <div className="overflow-y-auto flex-1">
        <button
          onClick={() => onSelect(null)}
          className="flex items-center gap-2 w-full px-3 py-2 hover:bg-gray-50 text-sm cursor-pointer transition-colors"
        >
          <div className="w-7 h-7 rounded bg-gray-100 flex items-center justify-center shrink-0">
            <MdFolder className="text-gray-500 text-sm" />
          </div>
          <span className="flex-1 text-left text-gray-800">/ (root)</span>
          {activeDest == null && <MdCheck className="text-blue-600 text-base shrink-0" />}
        </button>
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          folders.map((f) => (
            <button
              key={f.id}
              onClick={() => onSelect(f.id)}
              className="flex items-center gap-2 w-full px-3 py-2 hover:bg-gray-50 text-sm cursor-pointer transition-colors"
            >
              <div className={`w-7 h-7 rounded flex items-center justify-center shrink-0 ${
                f.kind === 'media' ? 'bg-purple-50' : 'bg-gray-100'
              }`}>
                {f.kind === 'media'
                  ? <MdPhotoLibrary className="text-purple-400 text-sm" />
                  : <MdFolder className="text-gray-500 text-sm" />}
              </div>
              <span className="flex-1 text-left text-gray-800 truncate">{f.name}</span>
              {activeDest === f.id && <MdCheck className="text-blue-600 text-base shrink-0" />}
            </button>
          ))
        )}
        {!loading && folders.length === 0 && (
          <p className="text-xs text-gray-400 px-3 py-3 text-center">No folders yet — files will be saved to root.</p>
        )}
      </div>
    </div>
  )
}
