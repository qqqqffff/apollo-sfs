import { useState } from 'react'
import type { File as ApiFile, Folder } from '../types/api'

const DRAG_TYPE = 'application/x-apollo-file'

function createGhost(name: string): HTMLElement {
  const el = document.createElement('div')
  el.textContent = `📄 ${name}`
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

export function useFileDrag(onMove: (fileId: string, targetFolderId: string) => void) {
  const [draggingFileId, setDraggingFileId] = useState<string | null>(null)
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)

  function getFileDragHandlers(file: ApiFile) {
    return {
      draggable: true as const,
      onDragStart(e: React.DragEvent) {
        setDraggingFileId(file.id)
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(DRAG_TYPE, file.id)
        const ghost = createGhost(file.name)
        e.dataTransfer.setDragImage(ghost, 14, 16)
        requestAnimationFrame(() => ghost.remove())
      },
      onDragEnd() {
        setDraggingFileId(null)
        setDragOverFolderId(null)
      },
    }
  }

  function getFolderDropHandlers(folder: Folder) {
    return {
      onDragEnter(e: React.DragEvent) {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
        e.preventDefault()
        setDragOverFolderId(folder.id)
      },
      onDragOver(e: React.DragEvent) {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      },
      onDragLeave(e: React.DragEvent) {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragOverFolderId((prev) => (prev === folder.id ? null : prev))
        }
      },
      onDrop(e: React.DragEvent) {
        e.preventDefault()
        setDragOverFolderId(null)
        const fileId = e.dataTransfer.getData(DRAG_TYPE)
        if (fileId) onMove(fileId, folder.id)
      },
    }
  }

  return { draggingFileId, dragOverFolderId, getFileDragHandlers, getFolderDropHandlers }
}
