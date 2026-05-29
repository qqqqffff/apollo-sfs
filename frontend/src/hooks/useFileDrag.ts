import { useState } from 'react'
import type { File as ApiFile, Folder } from '../types/api'

const FILE_DRAG_TYPE = 'application/x-apollo-file'
const FOLDER_DRAG_TYPE = 'application/x-apollo-folder'

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
) {
  const [draggingFileId, setDraggingFileId] = useState<string | null>(null)
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null)
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)

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
        }
      },
      onDrop(e: React.DragEvent) {
        e.preventDefault()
        setDragOverFolderId(null)
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
