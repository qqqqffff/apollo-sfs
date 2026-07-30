import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MdAlternateEmail,
  MdAttachFile,
  MdBolt,
  MdCheck,
  MdClose,
  MdCloud,
  MdExpandLess,
  MdExpandMore,
  MdMarkEmailUnread,
  MdSearch,
  MdSettings,
  MdStar,
  MdStarOutline,
  MdStorage,
} from 'react-icons/md'
import type { MyServer } from '../api/storage'
import type { EmailProvider, FetchProgress, ProviderEmailItem } from '../api/emailProviders'
import {
  backupEmailEntries,
  completeEmailBackupRun,
  deleteProviderMessages,
  ensureEmailBackupFolder,
  loadEmailBackupSettings,
  removeBackedUpMessages,
  saveEmailBackupSettings,
  type EmailBackupItemStatus,
  type EmailBackupResult,
} from '../api/emailBackup'
import {
  createBackupControl,
  readCancelAction,
  type BackupControl,
  type CancelAction,
} from '../api/backupControl'
import { useBackupLiveSync } from '../hooks/useBackupLiveSync'
import { BackupProgressBar, BackupProgressDetails, BackupRunControls } from './BackupProgress'
import { BackupCancelModal } from './BackupCancelModal'
import { ApiError } from '../api/client'
import { SettingToggle } from './SettingToggle'

interface Props {
  provider: EmailProvider
  accessToken: string
  accountEmail: string
  // Grows while the mailbox is still being paged — the table renders what has
  // arrived instead of waiting for the whole retrieval to finish.
  items: ProviderEmailItem[]
  // True while more pages are still coming in.
  fetching: boolean
  fetchProgress: FetchProgress | null
  // Ends the retrieval early, keeping whatever has been fetched.
  onStopFetching: () => void
  quotaBytes: number
  usedBytes: number
  myServers: MyServer[] | undefined
  onClose: () => void
  // Called from the finished screen; folderId lets the caller jump into the
  // new backup folder.
  onDone: (folderId: string | null) => void
  // Called instead of running the upload inline when "Back up in the
  // background" is on — mirrors GoogleBackupModal's onStartBackground. The
  // folder is already created by the time this fires.
  onStartBackground: (items: ProviderEmailItem[], folder: { id: string; drive_id: string | null }) => void
}

type Phase = 'pick' | 'uploading' | 'finished'

function fmt(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// EmailBackupModal is the picker + upload flow for an email backup (mirrors
// GoogleBackupModal): filter and select messages, choose the destination
// tier/server and the delete-after / notify settings, then back everything up
// with per-message progress.
export function EmailBackupModal({
  provider, accessToken, accountEmail, items, fetching, fetchProgress, onStopFetching,
  quotaBytes, usedBytes, myServers, onClose, onDone, onStartBackground,
}: Props) {
  const [tab, setTab] = useState<'emails' | 'settings'>('emails')
  const [phase, setPhase] = useState<Phase>('pick')

  // ── Filters ────────────────────────────────────────────────────────────────
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [starredOnly, setStarredOnly] = useState(false)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [attachmentsOnly, setAttachmentsOnly] = useState(false)
  const [senderFilter, setSenderFilter] = useState<Set<string>>(new Set())
  const [sendersOpen, setSendersOpen] = useState(false)

  // ── Selection ──────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(() => new Set(items.map((i) => i.id)))
  // Everything is selected by default, including messages that arrive while the
  // retrieval is still paging — but only until the user makes a choice of their
  // own, after which late arrivals stay unselected rather than silently
  // re-adding themselves to a curated selection.
  const [selectionTouched, setSelectionTouched] = useState(false)
  useEffect(() => {
    if (selectionTouched) return
    setSelected(new Set(items.map((i) => i.id)))
  }, [items, selectionTouched])

  // ── Settings ───────────────────────────────────────────────────────────────
  const [settings, setSettings] = useState(loadEmailBackupSettings)
  const [driveId, setDriveId] = useState<string | null>(
    () => myServers?.find((s) => s.is_primary)?.drive_id ?? myServers?.[0]?.drive_id ?? null,
  )

  // ── Upload state ───────────────────────────────────────────────────────────
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [statusMap, setStatusMap] = useState<Record<string, EmailBackupItemStatus>>({})
  const [result, setResult] = useState<EmailBackupResult | null>(null)
  const [folderId, setFolderId] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null)
  // Live detail for the in-flight run: where the current message is being
  // written and how much has actually landed.
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [storedBytes, setStoredBytes] = useState(0)
  const [storedCount, setStoredCount] = useState(0)
  const [paused, setPaused] = useState(false)
  const [cancelPrompt, setCancelPrompt] = useState(false)
  const [rollbackBusy, setRollbackBusy] = useState(false)
  const [cancelNote, setCancelNote] = useState<string | null>(null)
  const controlRef = useRef<BackupControl | null>(null)
  // Set by the cancel dialog before the run is stopped, so the continuation in
  // handleBackUp knows whether to roll the partial backup back.
  const cancelActionRef = useRef<CancelAction>('keep')
  const liveSync = useBackupLiveSync([['email-backup']])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase === 'pick') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [phase, onClose])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  // ── Senders summary (for the sender filter) ────────────────────────────────
  const senders = useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of items) counts.set(i.fromAddr, (counts.get(i.fromAddr) ?? 0) + 1)
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([addr, count]) => ({ addr, count }))
  }, [items])

  // ── Filtered view ──────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const fromTs = dateFrom ? new Date(dateFrom + 'T00:00:00').getTime() : null
    const toTs = dateTo ? new Date(dateTo + 'T23:59:59.999').getTime() : null
    return items.filter((i) => {
      if (starredOnly && !i.starred) return false
      if (unreadOnly && !i.unread) return false
      if (attachmentsOnly && !i.hasAttachments) return false
      if (senderFilter.size > 0 && !senderFilter.has(i.fromAddr)) return false
      const ts = new Date(i.date).getTime()
      if (fromTs !== null && (Number.isNaN(ts) || ts < fromTs)) return false
      if (toTs !== null && (Number.isNaN(ts) || ts > toTs)) return false
      if (q && !`${i.subject} ${i.from} ${i.snippet}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [items, search, dateFrom, dateTo, starredOnly, unreadOnly, attachmentsOnly, senderFilter])

  const allVisibleSelected = filtered.length > 0 && filtered.every((i) => selected.has(i.id))

  function toggle(id: string) {
    setSelectionTouched(true)
    setSelected((prev) => {
      const s = new Set(prev)
      s.has(id) ? s.delete(id) : s.add(id)
      return s
    })
  }

  // "All" adds the rows the current filter shows; "None" clears the *whole*
  // selection, not just those rows. Clearing only the visible ones left
  // filtered-out messages selected behind the filter — invisible on screen but
  // still part of the backup, so narrowing the list and pressing None then
  // picking a handful used to back up everything that had been fetched.
  function toggleAllVisible() {
    setSelectionTouched(true)
    setSelected((prev) => {
      if (allVisibleSelected) return new Set()
      const s = new Set(prev)
      filtered.forEach((i) => s.add(i.id))
      return s
    })
  }

  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.id)), [items, selected])

  // Selected messages the current filter hides. They are still part of the
  // backup, so say so rather than letting the count silently disagree with
  // what the table shows.
  const hiddenSelected = useMemo(() => {
    const visible = new Set(filtered.map((i) => i.id))
    return selectedItems.filter((i) => !visible.has(i.id))
  }, [filtered, selectedItems])

  function deselectHidden() {
    setSelectionTouched(true)
    const hidden = new Set(hiddenSelected.map((i) => i.id))
    setSelected((prev) => new Set(Array.from(prev).filter((id) => !hidden.has(id))))
  }

  // ── Quota ──────────────────────────────────────────────────────────────────
  const selectedSize = useMemo(
    () => selectedItems.reduce((sum, i) => sum + i.sizeEstimate, 0),
    [selectedItems],
  )
  const hasUnsizedItems = selectedItems.some((i) => i.sizeEstimate === 0)
  const projectedUsed = usedBytes + selectedSize
  const isOverQuota = quotaBytes > 0 && projectedUsed > quotaBytes
  const usedPct = quotaBytes > 0 ? Math.min((usedBytes / quotaBytes) * 100, 100) : 0
  const fitsPct = quotaBytes > 0
    ? (Math.max(0, Math.min(selectedSize, quotaBytes - usedBytes)) / quotaBytes) * 100
    : 0
  const overflowPct = isOverQuota ? Math.max(0, 100 - usedPct - fitsPct) : 0

  // ── Destination picker helpers ─────────────────────────────────────────────
  const servers = myServers ?? []
  const selectedServer = servers.find((s) => s.drive_id === driveId)
  const tier: 'nvme' | 'hdd' = selectedServer?.drive_type ?? servers.find((s) => s.is_primary)?.drive_type ?? 'nvme'
  const hasBothTiers = servers.some((s) => s.drive_type === 'nvme') && servers.some((s) => s.drive_type === 'hdd')
  const serversInTier = servers.filter((s) => s.drive_type === tier)

  function handleTierChange(t: 'nvme' | 'hdd') {
    const inTier = servers.filter((s) => s.drive_type === t)
    const primaryInTier = inTier.find((s) => s.is_primary)
    setDriveId(primaryInTier?.drive_id ?? inTier[0]?.drive_id ?? null)
  }

  function updateSettings(patch: Partial<{ deleteAfter: boolean; notify: boolean; background: boolean }>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveEmailBackupSettings(next)
      return next
    })
  }

  // ── Backup ─────────────────────────────────────────────────────────────────
  async function handleBackUp() {
    if (selectedItems.length === 0 || isOverQuota) return
    setUploadError(null)

    let folder: { id: string; drive_id: string | null } | null = null
    try {
      const folderRes = await ensureEmailBackupFolder(accountEmail, driveId)
      folder = folderRes.folder
    } catch (e) {
      setUploadError(
        e instanceof ApiError ? e.message : 'Could not create the backup folder. Please try again.',
      )
      return
    }

    if (settings.background) {
      onStartBackground(selectedItems, folder)
      return
    }

    const control = createBackupControl()
    controlRef.current = control
    cancelActionRef.current = 'keep'
    // An existing backup folder keeps its own pin, so credit that drive's
    // quota bar rather than the one selected in Settings.
    const destDriveId = folder.drive_id ?? driveId

    setPhase('uploading')
    setFolderId(folder.id)
    setStatusMap({})
    setStoredBytes(0)
    setStoredCount(0)
    setCancelNote(null)
    setProgress({ done: 0, total: selectedItems.length })

    const res = await backupEmailEntries(selectedItems, provider, accessToken, folder.id, {
      control,
      folderName: accountEmail,
      onProgress: (e) => {
        setProgress({ done: e.done, total: e.total })
        if (e.phase === 'start') { setCurrentPath(e.path); return }
        if (e.status) setStatusMap((m) => ({ ...m, [e.entry.id]: e.status! }))
        if (e.status === 'done') {
          setCurrentPath(e.path)
          setStoredBytes((b) => b + (e.sizeBytes ?? 0))
          setStoredCount((c) => c + 1)
          // Show it in the file browser and on the quota bar right away.
          liveSync.itemStored({ sizeBytes: e.sizeBytes ?? 0, driveId: destDriveId })
        }
      },
    })

    let removed = 0
    const cancelAction = readCancelAction(cancelActionRef)
    if (res.cancelled && cancelAction === 'remove' && res.uploadedMessageIds.length > 0) {
      setRollbackBusy(true)
      const rollback = await removeBackedUpMessages(res.uploadedMessageIds)
      removed = rollback.removed
      setRollbackBusy(false)
      setCancelNote(
        rollback.failed === 0
          ? `Backup cancelled — ${removed} email${removed !== 1 ? 's' : ''} removed again.`
          : `Backup cancelled — ${removed} of ${res.uploadedMessageIds.length} removed; ${rollback.failed} could not be deleted.`,
      )
    } else if (res.cancelled) {
      setCancelNote(`Backup cancelled — ${res.uploaded} email${res.uploaded !== 1 ? 's' : ''} kept.`)
    }

    controlRef.current = null
    setCancelPrompt(false)
    setPaused(false)
    setCurrentPath(null)
    setResult(res)
    liveSync.finish()

    // Only trash messages provider-side that are still backed up here — a
    // rollback just removed the copies that would have justified it.
    if (settings.deleteAfter && removed === 0 && res.backedUpIds.length > 0) {
      const { failed } = await deleteProviderMessages(provider, accessToken, res.backedUpIds)
      const deleted = res.backedUpIds.length - failed
      const where = provider === 'gmail' ? 'Gmail trash' : 'Deleted Items'
      setCleanupMsg(
        failed === 0
          ? `${deleted} email${deleted !== 1 ? 's' : ''} moved to your ${where}.`
          : `${deleted} of ${res.backedUpIds.length} moved to your ${where}; ${failed} could not be deleted.`,
      )
    }

    // Best effort — the backup itself already succeeded.
    try {
      await completeEmailBackupRun({
        folder_id: folder.id,
        email_address: accountEmail,
        provider,
        uploaded: Math.max(0, res.uploaded - removed),
        duplicates: res.duplicates,
        errors: res.errors,
        notify: settings.notify,
      })
    } catch { /* ignore */ }

    setPhase('finished')
  }

  function togglePause() {
    const control = controlRef.current
    if (!control) return
    if (control.isPaused()) { control.resume(); setPaused(false) }
    else { control.pause(); setPaused(true) }
  }

  // Cancel pauses first, then asks what should happen to the part that landed.
  function requestCancel() {
    controlRef.current?.pause()
    setPaused(true)
    setCancelPrompt(true)
  }

  function resolveCancel(action: CancelAction) {
    cancelActionRef.current = action
    setCancelPrompt(false)
    // Releases the loop, which stops and returns a partial result — the
    // continuation in handleBackUp does the rollback and the summary.
    controlRef.current?.cancel()
  }

  const canBackUp = selectedItems.length > 0 && !isOverQuota && phase === 'pick' && !fetching
  const uploading = phase === 'uploading'
  const finished = phase === 'finished'
  const listData = uploading || finished ? selectedItems : filtered

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div
        className="bg-white rounded-xl shadow-2xl flex flex-col"
        style={{ width: 720, maxWidth: '96vw', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0">
          <button
            onClick={finished ? () => onDone(folderId) : onClose}
            disabled={uploading}
            className="p-1 rounded hover:bg-gray-100 text-gray-500 cursor-pointer transition-colors disabled:opacity-30"
          >
            <MdClose className="text-xl" />
          </button>
          <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 min-w-0">
            <MdAlternateEmail className="text-teal-500 text-base shrink-0" />
            <span className="truncate">Email Backup — {accountEmail}</span>
          </span>
          {phase === 'pick' ? (
            <button
              onClick={toggleAllVisible}
              title={allVisibleSelected ? 'Clear the whole selection' : 'Select every email the filters show'}
              className="text-xs font-semibold text-blue-600 hover:text-blue-700 cursor-pointer px-1"
            >
              {allVisibleSelected ? 'None' : 'All'}
            </button>
          ) : <div className="w-10" />}
        </div>

        {/* Retrieval progress — the table fills in while this runs */}
        {fetching && phase === 'pick' && (
          <div className="px-4 py-2 border-b border-gray-100 bg-blue-50/40 shrink-0 flex items-center gap-3">
            <div className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-blue-700 truncate">
                  Retrieving your emails — {items.length.toLocaleString()} loaded so far
                </span>
                {fetchProgress?.fraction != null && (
                  <span className="text-blue-500 shrink-0">{Math.round(fetchProgress.fraction * 100)}%</span>
                )}
              </div>
              <div className="h-1 bg-blue-100 rounded-full overflow-hidden mt-1">
                {fetchProgress?.fraction != null ? (
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all"
                    style={{ width: `${Math.round(fetchProgress.fraction * 100)}%` }}
                  />
                ) : (
                  // No measurable target (e.g. an unbounded date range) — show
                  // motion rather than a bar that never fills.
                  <div className="h-full w-1/3 bg-blue-400 rounded-full animate-pulse" />
                )}
              </div>
            </div>
            <button
              onClick={onStopFetching}
              className="text-xs font-semibold text-blue-600 hover:text-blue-700 cursor-pointer px-1 shrink-0"
            >
              Stop
            </button>
          </div>
        )}

        {/* Tab bar */}
        {phase === 'pick' && (
          <div className="flex gap-1 px-4 py-2 border-b border-gray-200 shrink-0">
            {(['emails', 'settings'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-colors ${
                  tab === t ? 'bg-blue-50 text-blue-600' : 'text-gray-500 hover:bg-gray-50'
                }`}
              >
                {t === 'settings' && <MdSettings className="text-sm" />}
                {t === 'emails' ? `Emails (${items.length})` : 'Settings'}
              </button>
            ))}
          </div>
        )}

        {tab === 'settings' && phase === 'pick' ? (
          // ── Settings tab ────────────────────────────────────────────────
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {/* Destination tier/server */}
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="text-sm font-semibold text-gray-900">Backup storage location</div>
              <div className="text-xs text-gray-500 mt-0.5 leading-relaxed mb-3">
                The backup folder &ldquo;{accountEmail}&rdquo; is created in your root directory and its
                emails are stored on the server and tier you pick here. An existing backup folder keeps
                its current location.
              </div>
              {servers.length === 0 ? (
                <p className="text-xs text-gray-400 m-0">No storage server assigned yet — uploads use the default routing.</p>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  {hasBothTiers ? (
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleTierChange('nvme')}
                        title="Fast tier (NVMe)"
                        className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md cursor-pointer transition-colors ${
                          tier === 'nvme' ? 'bg-blue-50 text-blue-600' : 'text-gray-400 hover:bg-gray-100'
                        }`}
                      >
                        <MdBolt className="text-sm" /> Fast
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTierChange('hdd')}
                        title="Standard tier (HDD)"
                        className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md cursor-pointer transition-colors ${
                          tier === 'hdd' ? 'bg-amber-50 text-amber-600' : 'text-gray-400 hover:bg-gray-100'
                        }`}
                      >
                        <MdStorage className="text-sm" /> Standard
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs text-gray-500">{tier === 'nvme' ? 'Fast' : 'Standard'} tier</span>
                  )}
                  {serversInTier.length > 1 ? (
                    <select
                      value={driveId ?? ''}
                      onChange={(e) => setDriveId(e.target.value)}
                      className="text-xs border border-gray-200 rounded-md px-1.5 py-1 text-gray-700 bg-white cursor-pointer"
                    >
                      {serversInTier.map((s) => (
                        <option key={s.drive_id} value={s.drive_id}>{s.name}</option>
                      ))}
                    </select>
                  ) : (
                    serversInTier[0] && <span className="text-xs text-gray-500">{serversInTier[0].name}</span>
                  )}
                </div>
              )}
              {servers.length > 0 && (
                <div className="mt-3 flex items-center gap-1.5 text-xs font-medium text-gray-600 bg-white rounded-md border border-gray-200 px-2.5 py-1.5 w-fit max-w-full">
                  {tier === 'nvme' ? <MdBolt className="text-blue-500 shrink-0" /> : <MdStorage className="text-amber-500 shrink-0" />}
                  <span className="shrink-0">{tier === 'nvme' ? 'Fast' : 'Standard'}</span>
                  <span className="text-gray-300 shrink-0">›</span>
                  <span className="truncate">{accountEmail}</span>
                </div>
              )}
            </div>

            <SettingToggle
              title="Back up in the background"
              desc="Close this window when you start a backup and keep uploading, with progress shown in the toolbar."
              checked={settings.background}
              onChange={(v) => updateSettings({ background: v })}
            />
            <SettingToggle
              title="Delete emails after backup"
              desc={provider === 'gmail'
                ? 'Move each backed-up email to your Gmail trash once it is safely stored.'
                : 'Move each backed-up email to your Deleted Items folder once it is safely stored.'}
              checked={settings.deleteAfter}
              onChange={(v) => updateSettings({ deleteAfter: v })}
            />
            <SettingToggle
              title="Notify me when the backup completes"
              desc="Adds a notification to your bell with the backup results."
              checked={settings.notify}
              onChange={(v) => updateSettings({ notify: v })}
            />
          </div>
        ) : (
          // ── Emails tab ──────────────────────────────────────────────────
          <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
            {/* Quota card */}
            {quotaBytes > 0 && (
              <div className="mx-4 mt-3 p-3 bg-gray-50 rounded-lg border border-gray-100 shrink-0">
                <div className="flex justify-between items-center text-xs mb-1.5">
                  <span className="font-semibold text-gray-700">
                    {selectedItems.length} of {items.length} email{items.length !== 1 ? 's' : ''} selected
                  </span>
                  <span className={isOverQuota ? 'font-semibold text-red-500' : 'text-gray-500'}>
                    {fmt(selectedSize)}
                  </span>
                </div>
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden flex">
                  <div className="h-full bg-blue-500/40 transition-all" style={{ width: `${usedPct}%` }} />
                  <div
                    className="h-full transition-all"
                    style={{ width: `${fitsPct}%`, backgroundColor: isOverQuota ? '#ef4444' : '#3b82f6' }}
                  />
                  {isOverQuota && overflowPct > 0 && (
                    <div className="h-full bg-red-300" style={{ width: `${overflowPct}%` }} />
                  )}
                </div>
                <div className="flex justify-between text-[10px] text-gray-400 mt-1">
                  <span>After: {fmt(projectedUsed)}</span>
                  <span>Quota: {fmt(quotaBytes)}</span>
                </div>
                {hasUnsizedItems && (
                  <p className="text-[10px] text-gray-400 italic mt-0.5">
                    * Some emails don&apos;t report a size and are excluded from the estimate. The quota is
                    still enforced during upload.
                  </p>
                )}
                {phase === 'pick' && hiddenSelected.length > 0 && (
                  <div className="flex items-center gap-2 mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-md px-2 py-1">
                    <span className="flex-1">
                      {hiddenSelected.length.toLocaleString()} selected email
                      {hiddenSelected.length !== 1 ? 's are' : ' is'} hidden by the current filters and
                      will still be backed up.
                    </span>
                    <button
                      onClick={deselectHidden}
                      className="font-semibold underline cursor-pointer bg-transparent border-0 text-amber-700 shrink-0"
                    >
                      Deselect
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Over-quota strip */}
            {isOverQuota && (
              <div className="mx-4 mt-2 flex items-center gap-2 bg-red-500 text-white rounded-lg px-3 py-2 text-xs shrink-0">
                <span className="flex-1 font-medium">Selection exceeds your quota</span>
                <a href="/premium" className="font-bold underline">Get more storage →</a>
              </div>
            )}

            {uploadError && (
              <div className="mx-4 mt-2 flex items-center gap-2 bg-red-50 border border-red-200 text-red-600 rounded-lg px-3 py-2 text-xs shrink-0">
                <span className="flex-1">{uploadError}</span>
                <button onClick={() => setUploadError(null)} className="text-red-400 hover:text-red-600 cursor-pointer"><MdClose /></button>
              </div>
            )}

            {/* Filter bar */}
            {phase === 'pick' && (
              <div className="px-4 pt-3 pb-1 shrink-0 flex flex-col gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-1.5 flex-1 min-w-40 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5">
                    <MdSearch className="text-gray-400 text-base shrink-0" />
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search subject, sender, or text"
                      className="flex-1 bg-transparent border-0 outline-none text-xs text-gray-800 placeholder-gray-400 min-w-0"
                    />
                  </div>
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    title="From date"
                    className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 bg-white cursor-pointer"
                  />
                  <span className="text-xs text-gray-400">–</span>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    title="To date"
                    className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 bg-white cursor-pointer"
                  />
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <FilterChip
                    active={starredOnly}
                    onClick={() => setStarredOnly((v) => !v)}
                    icon={<MdStar className="text-sm" />}
                    label={provider === 'gmail' ? 'Starred' : 'Flagged'}
                  />
                  <FilterChip
                    active={unreadOnly}
                    onClick={() => setUnreadOnly((v) => !v)}
                    icon={<MdMarkEmailUnread className="text-sm" />}
                    label="Unread"
                  />
                  <FilterChip
                    active={attachmentsOnly}
                    onClick={() => setAttachmentsOnly((v) => !v)}
                    icon={<MdAttachFile className="text-sm" />}
                    label="Attachments"
                  />
                  <button
                    onClick={() => setSendersOpen((v) => !v)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium cursor-pointer transition-colors ${
                      senderFilter.size > 0 ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    Senders{senderFilter.size > 0 ? ` (${senderFilter.size})` : ''}
                    {sendersOpen ? <MdExpandLess className="text-sm" /> : <MdExpandMore className="text-sm" />}
                  </button>
                  {(starredOnly || unreadOnly || attachmentsOnly || senderFilter.size > 0 || search || dateFrom || dateTo) && (
                    <button
                      onClick={() => {
                        setSearch(''); setDateFrom(''); setDateTo('')
                        setStarredOnly(false); setUnreadOnly(false); setAttachmentsOnly(false)
                        setSenderFilter(new Set()); setSendersOpen(false)
                      }}
                      className="text-xs text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 px-1"
                    >
                      Clear filters
                    </button>
                  )}
                  <span className="ml-auto text-[11px] text-gray-400">{filtered.length} shown</span>
                </div>

                {/* Sender filter panel */}
                {sendersOpen && (
                  <div className="border border-gray-200 rounded-lg max-h-40 overflow-y-auto divide-y divide-gray-50">
                    {senders.map(({ addr, count }) => {
                      const active = senderFilter.has(addr)
                      return (
                        <button
                          key={addr}
                          onClick={() =>
                            setSenderFilter((prev) => {
                              const s = new Set(prev)
                              s.has(addr) ? s.delete(addr) : s.add(addr)
                              return s
                            })
                          }
                          className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-gray-50 cursor-pointer transition-colors bg-transparent border-0 text-left"
                        >
                          <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                            active ? 'bg-blue-600 border-blue-600' : 'border-gray-300'
                          }`}>
                            {active && <MdCheck className="text-white text-[10px]" />}
                          </span>
                          <span className="flex-1 text-xs text-gray-700 truncate">{addr || '(unknown sender)'}</span>
                          <span className="text-[10px] text-gray-400 shrink-0">{count}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Email list */}
            <div className="flex-1 overflow-y-auto min-h-0 mt-1">
              {listData.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-8">No emails match the current filters.</p>
              )}
              {listData.map((item) => (
                <EmailRow
                  key={item.id}
                  item={item}
                  checked={selected.has(item.id)}
                  status={statusMap[item.id]}
                  disabled={phase !== 'pick'}
                  onToggle={() => toggle(item.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="border-t border-gray-200 px-4 py-3 flex flex-col gap-2 shrink-0">
          {uploading && progress && (
            <>
              <BackupProgressBar done={progress.done} total={progress.total} paused={paused} />
              <BackupProgressDetails
                currentPath={currentPath}
                storedBytes={storedBytes}
                totalBytes={selectedSize}
                paused={paused}
              />
              <BackupRunControls
                paused={paused}
                busy={rollbackBusy}
                onTogglePause={togglePause}
                onCancel={requestCancel}
              />
            </>
          )}

          {cancelNote && <p className="text-xs text-center text-amber-600">{cancelNote}</p>}

          {finished && result && (
            <p className={`text-xs text-center ${result.errors > 0 ? 'text-amber-600' : 'text-green-600'}`}>
              {[
                `${result.uploaded} backed up`,
                result.duplicates > 0 ? `${result.duplicates} duplicate${result.duplicates !== 1 ? 's' : ''}` : null,
                result.errors > 0 ? `${result.errors} failed` : null,
              ].filter(Boolean).join(' · ')}
            </p>
          )}

          {cleanupMsg && <p className="text-xs text-gray-500 text-center">{cleanupMsg}</p>}

          {finished ? (
            <button
              onClick={() => onDone(folderId)}
              className="flex items-center justify-center gap-2 py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-lg cursor-pointer transition-colors"
            >
              <MdCheck className="text-base" /> Open backup folder
            </button>
          ) : !uploading && (
            <button
              onClick={handleBackUp}
              disabled={!canBackUp}
              className="flex items-center justify-center gap-2 py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-lg cursor-pointer transition-colors disabled:opacity-40"
            >
              <MdCloud className="text-base" />
              {fetching
                ? `Retrieving emails… (${items.length.toLocaleString()} so far)`
                : isOverQuota
                  ? 'Over quota — deselect emails or upgrade'
                  : selectedItems.length === 0
                    ? 'No emails selected'
                    : `Back Up ${selectedItems.length} Email${selectedItems.length !== 1 ? 's' : ''}`}
            </button>
          )}
        </div>
      </div>

      {/* Cancel confirmation — the run is paused behind it */}
      {cancelPrompt && (
        <BackupCancelModal
          storedCount={storedCount}
          storedBytes={storedBytes}
          unit="email"
          busy={rollbackBusy}
          onRemove={() => resolveCancel('remove')}
          onKeep={() => resolveCancel('keep')}
          onResume={() => {
            setCancelPrompt(false)
            controlRef.current?.resume()
            setPaused(false)
          }}
        />
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FilterChip({ active, onClick, icon, label }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium cursor-pointer transition-colors ${
        active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
      }`}
    >
      {icon} {label}
    </button>
  )
}

function EmailRow({ item, checked, status, disabled, onToggle }: {
  item: ProviderEmailItem
  checked: boolean
  status: EmailBackupItemStatus | undefined
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <div
      className={`flex items-center gap-2.5 px-4 py-2 border-b border-gray-50 hover:bg-gray-50/50 transition-colors ${
        !checked && !disabled ? 'opacity-50' : ''
      }`}
    >
      <button
        onClick={() => !disabled && onToggle()}
        disabled={disabled}
        aria-label={`${checked ? 'Deselect' : 'Select'} ${item.subject || '(no subject)'}`}
        aria-pressed={checked}
        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 cursor-pointer transition-colors ${
          checked ? 'bg-blue-600 border-blue-600' : 'border-gray-300'
        }`}
      >
        {checked && <MdCheck className="text-white text-xs" />}
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {item.unread && <span className="w-2 h-2 rounded-full bg-blue-600 shrink-0" aria-label="unread" />}
          <span className={`text-sm truncate ${item.unread ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
            {item.from || item.fromAddr || '(unknown sender)'}
          </span>
          <span className="ml-auto text-[11px] text-gray-400 whitespace-nowrap shrink-0">{fmtDate(item.date)}</span>
        </div>
        <div className="text-xs text-gray-600 truncate mt-0.5">{item.subject || '(no subject)'}</div>
        <div className="flex items-center gap-2 mt-0.5">
          {item.hasAttachments && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-gray-400">
              <MdAttachFile className="text-xs" /> attachment
            </span>
          )}
          {item.sizeEstimate > 0 && (
            <span className="text-[10px] text-gray-400">{fmt(item.sizeEstimate)}</span>
          )}
        </div>
      </div>

      {status ? (
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${
          status === 'done' ? 'bg-green-100 text-green-700'
          : status === 'duplicate' ? 'bg-amber-100 text-amber-700'
          : 'bg-red-100 text-red-600'
        }`}>
          {status === 'done' ? 'Backed up' : status === 'duplicate' ? 'Duplicate' : 'Failed'}
        </span>
      ) : item.starred ? (
        <MdStar className="text-amber-400 text-base shrink-0" title="Starred" />
      ) : (
        <MdStarOutline className="text-gray-200 text-base shrink-0" />
      )}
    </div>
  )
}
