import { useState, useEffect, useRef, useCallback } from 'react'

export function useDragDrop(onFiles: (files: globalThis.File[]) => void) {
  const [isDragging, setIsDragging] = useState(false)
  const enterCount = useRef(0)
  // Keep callback ref stable so the effect never needs to re-run
  const onFilesRef = useRef(onFiles)
  onFilesRef.current = onFiles

  useEffect(() => {
    const isFileDrag = (e: DragEvent) =>
      e.dataTransfer?.types != null && Array.from(e.dataTransfer.types).includes('Files')

    const handleDragEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      enterCount.current++
      setIsDragging(true)
    }

    const handleDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }

    const handleDragLeave = () => {
      if (enterCount.current > 0) {
        enterCount.current--
        if (enterCount.current === 0) setIsDragging(false)
      }
    }

    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      enterCount.current = 0
      setIsDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length > 0) onFilesRef.current(files)
    }

    document.addEventListener('dragenter', handleDragEnter)
    document.addEventListener('dragover', handleDragOver)
    document.addEventListener('dragleave', handleDragLeave)
    document.addEventListener('drop', handleDrop)

    return () => {
      document.removeEventListener('dragenter', handleDragEnter)
      document.removeEventListener('dragover', handleDragOver)
      document.removeEventListener('dragleave', handleDragLeave)
      document.removeEventListener('drop', handleDrop)
    }
  }, []) // stable — callback accessed via ref

  const cancelDrag = useCallback(() => {
    enterCount.current = 0
    setIsDragging(false)
  }, [])

  return { isDragging, cancelDrag }
}
