import { useQuery } from '@tanstack/react-query'
import { useLayoutEffect, useRef, useState } from 'react'
import { MdChevronRight, MdStorage } from 'react-icons/md'
import { ancestorsQueryOptions } from '../api/folders'
import { adminGetUserAncestors } from '../api/admin'
import { TierIcon } from './TierIcon'
import type { Folder } from '../types/api'

type FolderDropHandlers = {
  onDragEnter: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
}

interface Props {
  folderId: string | 'root'
  onNavigate: (folderId: string | undefined) => void
  // Optional trailing slot — the share-directory button sits here on premium
  // accounts so the breadcrumb row stays as one visual unit.
  trailing?: React.ReactNode
  // Set while an admin is browsing another user's files via impersonation —
  // routes the ancestors lookup through the admin-scoped endpoint instead of
  // the caller's own, since the folders belong to a different user.
  asUsername?: string
  // Tier-first browser: when set, the leading crumb is this drive (server &
  // tier) rather than a generic "root", with an "All storage" step before it
  // for multi-drive users. onNavigateDrive goes to the drive's root; onNavigate-
  // AllStorage goes to the super-level drive picker. The tier renders as a
  // colored TierIcon rather than a "Fast"/"Standard" text label.
  drive?: { id: string; name: string; type: 'nvme' | 'hdd'; showAllStorage: boolean }
  onNavigateDrive?: (driveId: string) => void
  onNavigateAllStorage?: () => void
  // Drag-to-move: dropping a file/folder being dragged (elsewhere in the
  // browser) onto an ancestor crumb moves it there. Only real folders are
  // droppable — not the root/drive/"All storage" crumbs, which have no
  // folder id to move into. Shares state/handlers with the folder list's own
  // drop targets (useFileDrag) so hover-to-open behaves identically in both.
  getFolderDropHandlers?: (folder: Folder) => FolderDropHandlers
  dragOverFolderId?: string | null
  // Drop target for the current folder itself (§3): unlike the ancestor
  // crumbs above, dropping here never navigates — it's already where we are
  // — so it stays a live target even after a drag hover-navigated in via a
  // folder row or another crumb and left nothing else to drop onto.
  currentDropHandlers?: FolderDropHandlers
  dragOverCurrent?: boolean
}

// FolderBreadcrumb renders the clickable path from root → current folder.
// The leading "root" is always the root sentinel. When the path doesn't fit
// the available width, the leftmost segments collapse into a single ".."
// button that navigates to the immediate parent of the current folder.
export function FolderBreadcrumb({
  folderId, onNavigate, trailing, asUsername, drive, onNavigateDrive, onNavigateAllStorage,
  getFolderDropHandlers, dragOverFolderId, currentDropHandlers, dragOverCurrent,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState<number>(0)
  const isRoot = folderId === 'root'
  const { data, isLoading } = useQuery({
    queryKey: ['folders', folderId, 'ancestors', asUsername ?? ''] as const,
    queryFn: asUsername
      ? () => adminGetUserAncestors(asUsername, folderId)
      : ancestorsQueryOptions(folderId).queryFn,
    enabled: !isRoot,
  })

  const ancestors: Folder[] = data?.ancestors ?? []

  // Track the crumbs wrapper's own rendered width so we know when to
  // truncate — it's a flex-1 sibling of `trailing` (see the render below), so
  // its clientWidth already reflects exactly the space left over after
  // trailing controls (e.g. the share button) claim their own room. The only
  // limiting factor is real available width — no artificial viewport cap —
  // so the breadcrumb spans the full file-list width and truncates only once
  // it actually runs out of room.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    setContainerWidth(el.clientWidth)
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth
      setContainerWidth(Math.floor(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const available = containerWidth

  // Estimate how many right-most ancestor segments fit. We approximate with
  // ~10 px per character (text-sm + chevron gap) which is conservative
  // enough to avoid overflow on the cramped end of the spectrum without
  // being so pessimistic that the breadcrumb collapses unnecessarily.
  const segments = isRoot ? [] : ancestors
  const totalChars = segments.reduce((n, f) => n + f.name.length + 3, 0) + 19 // 19 = leading "root"
  const fits = available === 0 || totalChars * 10 <= available

  // Tail = always show: current folder. Beyond that, fit as many as we can
  // counting backwards from the leaf.
  let visible = segments
  let truncated = false
  if (!fits && segments.length > 1) {
    const minTail = 1 // always keep the current folder
    let keep = minTail
    const leaf = segments[segments.length - 1]
    let chars = 19 + (leaf ? leaf.name.length : 0) + 6 // "root" + leaf + ".." section
    for (let i = segments.length - 2; i >= 0; i--) {
      chars += segments[i].name.length + 3
      if (chars * 10 > available) break
      keep++
    }
    visible = segments.slice(segments.length - keep)
    truncated = keep < segments.length
  }

  const parentOfCurrent = segments.length >= 2 ? segments[segments.length - 2] : undefined

  return (
    <div className="flex items-center gap-3 min-w-0 flex-1">
      <div
        ref={containerRef}
        className="flex items-center gap-1 text-sm text-gray-600 min-w-0 flex-1"
      >
      {drive && drive.showAllStorage && (
        <>
          <button
            onClick={() => onNavigateAllStorage?.()}
            title="All storage"
            aria-label="All storage"
            className="shrink-0 inline-flex items-center justify-center bg-transparent border-0 p-0 text-blue-600 hover:text-blue-700 cursor-pointer"
          >
            <MdStorage className="text-base" />
          </button>
          <Sep />
        </>
      )}
      {drive ? (
        <Crumb
          icon={<TierIcon type={drive.type} />}
          label={drive.name}
          title={drive.name}
          clickable={!isRoot}
          onClick={() => onNavigateDrive?.(drive.id)}
          current={isRoot}
        />
      ) : (
        <Crumb
          label="root"
          title="Root"
          clickable={!isRoot}
          onClick={() => onNavigate(undefined)}
          current={isRoot}
        />
      )}
      {!isRoot && truncated && parentOfCurrent && (
        <>
          <Sep />
          <Crumb
            label=".."
            title="Up one level"
            clickable
            onClick={() => onNavigate(parentOfCurrent.id)}
            dropHandlers={getFolderDropHandlers?.(parentOfCurrent)}
            dragOver={dragOverFolderId === parentOfCurrent.id}
          />
        </>
      )}
      {!isRoot && !isLoading && visible.map((f, i) => {
        const isCurrent = i === visible.length - 1
        return (
          <span key={f.id} className="flex items-center gap-1 min-w-0">
            <Sep />
            <Crumb
              label={f.name}
              title={isCurrent ? `Drop here to move into "${f.name}"` : f.name}
              clickable={!isCurrent}
              dropHandlers={isCurrent ? currentDropHandlers : getFolderDropHandlers?.(f)}
              dragOver={isCurrent ? !!dragOverCurrent : dragOverFolderId === f.id}
              onClick={() => onNavigate(f.id)}
              current={isCurrent}
            />
          </span>
        )
      })}
      </div>
      {trailing && <div className="flex items-center shrink-0">{trailing}</div>}
    </div>
  )
}

function Crumb({
  icon, label, title, onClick, clickable, current, dropHandlers, dragOver,
}: {
  icon?: React.ReactNode
  label: string
  title: string
  onClick: () => void
  clickable: boolean
  current?: boolean
  dropHandlers?: FolderDropHandlers
  dragOver?: boolean
}) {
  if (!clickable) {
    return (
      <span
        title={title}
        {...dropHandlers}
        className={`inline-flex items-center gap-1 truncate ${current ? 'font-semibold text-gray-900' : 'text-gray-500'} ${
          dragOver ? 'rounded px-1 -mx-1 bg-blue-50 ring-2 ring-blue-300 ring-inset' : ''
        }`}
      >
        {icon}
        <span className="truncate">{label}</span>
      </span>
    )
  }
  return (
    <button
      onClick={onClick}
      title={title}
      {...dropHandlers}
      className={`inline-flex items-center gap-1 truncate bg-transparent border-0 p-0 cursor-pointer text-blue-600 hover:underline ${
        dragOver ? 'rounded px-1 -mx-1 bg-blue-50 ring-2 ring-blue-300 ring-inset' : ''
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}

function Sep() {
  return <MdChevronRight className="text-gray-300 shrink-0" />
}
