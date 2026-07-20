import { useRef, useState } from 'react'
import type { File as ApiFile, Folder } from '../types/api'

const FILE_DRAG_TYPE = 'application/x-apollo-file'
const FOLDER_DRAG_TYPE = 'application/x-apollo-folder'

// How long a folder must stay hovered mid-drag before it auto-opens (mirrors
// "spring-loaded folder" behavior in desktop file managers) — long enough
// that a drag passing through on its way elsewhere doesn't trigger it.
const HOVER_OPEN_DELAY_MS = 700

function createGhost(name: string, isFolder = false): HTMLElement {
  const el = document.createElement('div')
  el.textContent = `${isFolder ? '📁' : '📄'} ${name}`
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
) {
  const [draggingFileId, setDraggingFileId] = useState<string | null>(null)
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null)
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
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
        const ghost = createGhost(file.name)
        e.dataTransfer.setDragImage(ghost, 14, 16)
        requestAnimationFrame(() => ghost.remove())
      },
      onDragEnd() {
        setDraggingFileId(null)
        setDragOverFolderId(null)
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
        const ghost = createGhost(folder.name, true)
        e.dataTransfer.setDragImage(ghost, 14, 16)
        requestAnimationFrame(() => ghost.remove())
      },
      onDragEnd() {
        setDraggingFolderId(null)
        setDragOverFolderId(null)
        clearHoverTimer()
      },
    }
  }

  function getFolderDropHandlers(folder: Folder) {
    return {
      onDragEnter(e: React.DragEvent) {
        const hasFile = e.dataTransfer.types.includes(FILE_DRAG_TYPE)
        const hasFolder = e.dataTransfer.types.includes(FOLDER_DRAG_TYPE)
        if (!hasFile && !hasFolder) return
        if (hasFolder && draggingFolderId === folder.id) return
        e.preventDefault()
        setDragOverFolderId(folder.id)
        scheduleHoverOpen(folder.id)
      },
      onDragOver(e: React.DragEvent) {
        const hasFile = e.dataTransfer.types.includes(FILE_DRAG_TYPE)
        const hasFolder = e.dataTransfer.types.includes(FOLDER_DRAG_TYPE)
        if (!hasFile && !hasFolder) return
        if (hasFolder && draggingFolderId === folder.id) return
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
        clearHoverTimer()
        const fileId = e.dataTransfer.getData(FILE_DRAG_TYPE)
        if (fileId) { onMoveFile(fileId, folder.id); return }
        const folderId = e.dataTransfer.getData(FOLDER_DRAG_TYPE)
        if (folderId && folderId !== folder.id) onMoveFolder(folderId, folder.id)
      },
    }
  }

  return {
    draggingFileId,
    draggingFolderId,
    dragOverFolderId,
    getFileDragHandlers,
    getFolderDragHandlers,
    getFolderDropHandlers,
  }
}
