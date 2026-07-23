import { useRef, useState } from 'react'
import type { File as ApiFile, Folder } from '../types/api'

const FILE_DRAG_TYPE = 'application/x-apollo-file'
const FOLDER_DRAG_TYPE = 'application/x-apollo-folder'
// Carries a JSON-encoded SelectionSnapshot when the dragged row is part of an
// active multi-selection — set alongside (not instead of) the single-item
// type above, so every existing hasFile/hasFolder type check keeps working
// unmodified; only onDrop needs to prefer this payload when present.
const SELECTION_DRAG_TYPE = 'application/x-apollo-selection'

// How long a folder must stay hovered mid-drag before it auto-opens (mirrors
// "spring-loaded folder" behavior in desktop file managers) — long enough
// that a drag passing through on its way elsewhere doesn't trigger it.
const HOVER_OPEN_DELAY_MS = 700

export interface SelectionSnapshot {
  fileIds: string[]
  folderIds: string[]
}

function createGhost(label: string): HTMLElement {
  const el = document.createElement('div')
  el.textContent = label
  el.style.cssText = [
    'position:fixed',
    'top:-9999px',
    'left:-9999px',
    'background:#fff',
    'border:1.5px solid #4a90e2',
    'border-radius:4px',
    'padding:6px 14px',
    'font-size:13px',
    'color:#222',
    'white-space:nowrap',
    'box-shadow:0 2px 8px rgba(0,0,0,0.15)',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
  ].join(';')
  document.body.appendChild(el)
  return el
}

export function useFileDrag(
  onMoveFile: (fileId: string, targetFolderId: string) => void,
  onMoveFolder: (folderId: string, targetFolderId: string) => void,
  // Optional: called when a folder has been hovered continuously (mid-drag)
  // for HOVER_OPEN_DELAY_MS, so the caller can navigate into it. The drag
  // itself is untouched by that navigation — draggingFileId/draggingFolderId/
  // dragOverFolderId all live here and survive a re-render of the caller.
  onHoverOpen?: (folderId: string) => void,
  // Multi-select drag: given the row actually grabbed, returns the full
  // selection to move together when that row is part of an active (size > 1)
  // selection, else null — in which case dragging behaves exactly as before
  // (moves just the one row).
  getSelectionSnapshot?: (id: string, kind: 'file' | 'folder') => SelectionSnapshot | null,
  // Called instead of onMoveFile/onMoveFolder when a drop's payload is a
  // multi-item selection. If omitted, falls back to looping onMoveFile/
  // onMoveFolder over the selection one at a time.
  onMoveMany?: (fileIds: string[], folderIds: string[], targetFolderId: string) => void,
) {
  const [draggingFileId, setDraggingFileId] = useState<string | null>(null)
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null)
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  // Highlights the list's own background (§2) — a fallback drop target for
  // "move to parent" when the pointer isn't over a more specific folder row.
  const [dragOverBackground, setDragOverBackground] = useState<boolean>(false)
  // Highlights the "drop into current folder" target (§3) — a standing target
  // for the folder actually being viewed, so a drag that hover-navigated
  // there (via a folder row or breadcrumb crumb's spring-load timer) still
  // has somewhere to land once the row/crumb it started over is gone.
  const [dragOverCurrent, setDragOverCurrent] = useState<boolean>(false)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverFolderIdRef = useRef<string | null>(null)

  function clearHoverTimer() {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    hoverFolderIdRef.current = null
  }

  function scheduleHoverOpen(folderId: string) {
    if (!onHoverOpen || hoverFolderIdRef.current === folderId) return
    clearHoverTimer()
    hoverFolderIdRef.current = folderId
    hoverTimerRef.current = setTimeout(() => {
      onHoverOpen(folderId)
      clearHoverTimer()
    }, HOVER_OPEN_DELAY_MS)
  }

  function getFileDragHandlers(file: ApiFile) {
    return {
      draggable: true as const,
      onDragStart(e: React.DragEvent) {
        setDraggingFileId(file.id)
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(FILE_DRAG_TYPE, file.id)
        const selection = getSelectionSnapshot?.(file.id, 'file')
        const total = selection ? selection.fileIds.length + selection.folderIds.length : 0
        if (selection && total > 1) e.dataTransfer.setData(SELECTION_DRAG_TYPE, JSON.stringify(selection))
        const ghost = createGhost(total > 1 ? `📦 ${total} items` : `📄 ${file.name}`)
        e.dataTransfer.setDragImage(ghost, 14, 16)
        requestAnimationFrame(() => ghost.remove())
      },
      onDragEnd() {
        setDraggingFileId(null)
        setDragOverFolderId(null)
        setDragOverBackground(false)
        clearHoverTimer()
      },
    }
  }

  function getFolderDragHandlers(folder: Folder) {
    return {
      draggable: true as const,
      onDragStart(e: React.DragEvent) {
        setDraggingFolderId(folder.id)
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(FOLDER_DRAG_TYPE, folder.id)
        const selection = getSelectionSnapshot?.(folder.id, 'folder')
        const total = selection ? selection.fileIds.length + selection.folderIds.length : 0
        if (selection && total > 1) e.dataTransfer.setData(SELECTION_DRAG_TYPE, JSON.stringify(selection))
        const ghost = createGhost(total > 1 ? `📦 ${total} items` : `📁 ${folder.name}`)
        e.dataTransfer.setDragImage(ghost, 14, 16)
        requestAnimationFrame(() => ghost.remove())
      },
      onDragEnd() {
        setDraggingFolderId(null)
        setDragOverFolderId(null)
        setDragOverBackground(false)
        clearHoverTimer()
      },
    }
  }

  // Resolves what's actually being dropped: a multi-item selection when
  // present, otherwise the single dragged file/folder. excludeFolderId keeps
  // a folder from being moved into itself (the drop target) — same guard the
  // single-item path always had, extended to filter a multi-selection too.
  function resolvePayload(dataTransfer: DataTransfer, excludeFolderId?: string): SelectionSnapshot | null {
    const raw = dataTransfer.getData(SELECTION_DRAG_TYPE)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<SelectionSnapshot>
        const fileIds = Array.isArray(parsed.fileIds) ? parsed.fileIds : []
        const folderIds = (Array.isArray(parsed.folderIds) ? parsed.folderIds : [])
          .filter((id) => id !== excludeFolderId)
        if (fileIds.length + folderIds.length > 0) return { fileIds, folderIds }
      } catch {
        // Malformed payload — fall through to the single-item types below.
      }
    }
    const fileId = dataTransfer.getData(FILE_DRAG_TYPE)
    if (fileId) return { fileIds: [fileId], folderIds: [] }
    const folderId = dataTransfer.getData(FOLDER_DRAG_TYPE)
    if (folderId && folderId !== excludeFolderId) return { fileIds: [], folderIds: [folderId] }
    return null
  }

  function runMove(payload: SelectionSnapshot, targetFolderId: string) {
    const total = payload.fileIds.length + payload.folderIds.length
    if (total === 0) return
    if (total === 1 && payload.folderIds.length === 1) {
      onMoveFolder(payload.folderIds[0], targetFolderId)
      return
    }
    if (total === 1 && payload.fileIds.length === 1) {
      onMoveFile(payload.fileIds[0], targetFolderId)
      return
    }
    if (onMoveMany) {
      onMoveMany(payload.fileIds, payload.folderIds, targetFolderId)
    } else {
      payload.fileIds.forEach((id) => onMoveFile(id, targetFolderId))
      payload.folderIds.forEach((id) => onMoveFolder(id, targetFolderId))
    }
  }

  function getFolderDropHandlers(folder: Folder) {
    return {
      onDragEnter(e: React.DragEvent) {
        const hasFile = e.dataTransfer.types.includes(FILE_DRAG_TYPE)
        const hasFolder = e.dataTransfer.types.includes(FOLDER_DRAG_TYPE)
        const hasSelection = e.dataTransfer.types.includes(SELECTION_DRAG_TYPE)
        if (!hasFile && !hasFolder && !hasSelection) return
        if (hasFolder && !hasSelection && draggingFolderId === folder.id) return
        e.preventDefault()
        setDragOverFolderId(folder.id)
        setDragOverBackground(false)
        scheduleHoverOpen(folder.id)
      },
      onDragOver(e: React.DragEvent) {
        const hasFile = e.dataTransfer.types.includes(FILE_DRAG_TYPE)
        const hasFolder = e.dataTransfer.types.includes(FOLDER_DRAG_TYPE)
        const hasSelection = e.dataTransfer.types.includes(SELECTION_DRAG_TYPE)
        if (!hasFile && !hasFolder && !hasSelection) return
        if (hasFolder && !hasSelection && draggingFolderId === folder.id) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      },
      onDragLeave(e: React.DragEvent) {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragOverFolderId((prev) => (prev === folder.id ? null : prev))
          if (hoverFolderIdRef.current === folder.id) clearHoverTimer()
        }
      },
      onDrop(e: React.DragEvent) {
        e.preventDefault()
        setDragOverFolderId(null)
        setDragOverBackground(false)
        clearHoverTimer()
        const payload = resolvePayload(e.dataTransfer, folder.id)
        if (payload) runMove(payload, folder.id)
      },
    }
  }

  // getListBackgroundDropHandlers is the fallback drop target for the list
  // area as a whole (§2): dropping anywhere that ISN'T a specific folder row
  // moves the dragged item(s) up to parentFolderId. Relies on native event
  // bubbling — a folder row's own onDrop/onDragEnter/onDragOver above always
  // calls preventDefault() first when it claims the drag, so by the time the
  // same event bubbles here e.defaultPrevented correctly says whether a more
  // specific target already handled it. No-ops when there's no parent to
  // move to (a drive/true root, or a top-level folder).
  function getListBackgroundDropHandlers(parentFolderId: string | null) {
    return {
      onDragEnter(e: React.DragEvent) {
        const hasFile = e.dataTransfer.types.includes(FILE_DRAG_TYPE)
        const hasFolder = e.dataTransfer.types.includes(FOLDER_DRAG_TYPE)
        const hasSelection = e.dataTransfer.types.includes(SELECTION_DRAG_TYPE)
        if (!hasFile && !hasFolder && !hasSelection) return
        if (e.defaultPrevented) { setDragOverBackground(false); return }
        if (parentFolderId === null) return
        e.preventDefault()
        setDragOverBackground(true)
      },
      onDragOver(e: React.DragEvent) {
        const hasFile = e.dataTransfer.types.includes(FILE_DRAG_TYPE)
        const hasFolder = e.dataTransfer.types.includes(FOLDER_DRAG_TYPE)
        const hasSelection = e.dataTransfer.types.includes(SELECTION_DRAG_TYPE)
        if (!hasFile && !hasFolder && !hasSelection) return
        if (e.defaultPrevented) { setDragOverBackground(false); return }
        if (parentFolderId === null) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      },
      onDragLeave(e: React.DragEvent) {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragOverBackground(false)
        }
      },
      onDrop(e: React.DragEvent) {
        if (e.defaultPrevented || parentFolderId === null) return
        e.preventDefault()
        setDragOverBackground(false)
        const payload = resolvePayload(e.dataTransfer)
        if (payload) runMove(payload, parentFolderId)
      },
    }
  }

  // getCurrentFolderDropHandlers is the standing "drop into this folder"
  // target for the folder actually being viewed (§3). Unlike
  // getFolderDropHandlers it never schedules a hover-open — we're already
  // here — so it's safe to keep mounted (in the breadcrumb's current crumb,
  // and in a small persistent drop banner) for the whole time a drag is over
  // the page, including after a hover-navigate elsewhere left no more specific
  // row or crumb to drop the item onto.
  function getCurrentFolderDropHandlers(folderId: string) {
    return {
      onDragEnter(e: React.DragEvent) {
        const hasFile = e.dataTransfer.types.includes(FILE_DRAG_TYPE)
        const hasFolder = e.dataTransfer.types.includes(FOLDER_DRAG_TYPE)
        const hasSelection = e.dataTransfer.types.includes(SELECTION_DRAG_TYPE)
        if (!hasFile && !hasFolder && !hasSelection) return
        if (hasFolder && !hasSelection && draggingFolderId === folderId) return
        e.preventDefault()
        setDragOverCurrent(true)
        setDragOverFolderId(null)
        setDragOverBackground(false)
        clearHoverTimer()
      },
      onDragOver(e: React.DragEvent) {
        const hasFile = e.dataTransfer.types.includes(FILE_DRAG_TYPE)
        const hasFolder = e.dataTransfer.types.includes(FOLDER_DRAG_TYPE)
        const hasSelection = e.dataTransfer.types.includes(SELECTION_DRAG_TYPE)
        if (!hasFile && !hasFolder && !hasSelection) return
        if (hasFolder && !hasSelection && draggingFolderId === folderId) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      },
      onDragLeave(e: React.DragEvent) {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragOverCurrent(false)
        }
      },
      onDrop(e: React.DragEvent) {
        e.preventDefault()
        setDragOverCurrent(false)
        const payload = resolvePayload(e.dataTransfer, folderId)
        if (payload) runMove(payload, folderId)
      },
    }
  }

  return {
    draggingFileId,
    draggingFolderId,
    dragOverFolderId,
    dragOverBackground,
    dragOverCurrent,
    getFileDragHandlers,
    getFolderDragHandlers,
    getFolderDropHandlers,
    getListBackgroundDropHandlers,
    getCurrentFolderDropHandlers,
  }
}
