import { renderHook, act } from '@testing-library/react'
import { useFileDrag } from '../../hooks/useFileDrag'
import type { File as ApiFile, Folder } from '../../types/api'

// ── Test data ─────────────────────────────────────────────────────────────────

const FILE: ApiFile = { id: 'f1', user_id: 'u1', name: 'doc.pdf', mime_type: 'application/pdf', size_bytes: 1024, created_at: '', updated_at: '', folder_id: null }
const FOLDER: Folder = { id: 'fold-1', user_id: 'u1', name: 'Docs', created_at: '', updated_at: '', parent_id: null }
const TARGET_FOLDER: Folder = { id: 'fold-target', user_id: 'u1', name: 'Target', created_at: '', updated_at: '', parent_id: null }

const FILE_DRAG_TYPE = 'application/x-apollo-file'
const FOLDER_DRAG_TYPE = 'application/x-apollo-folder'

function makeDataTransfer(type?: string, value?: string) {
  const store: Record<string, string> = {}
  if (type && value) store[type] = value
  return {
    types: type ? [type] : [],
    effectAllowed: '',
    dropEffect: '',
    setData: jest.fn((t: string, v: string) => { store[t] = v }),
    getData: jest.fn((t: string) => store[t] ?? ''),
    setDragImage: jest.fn(),
  }
}

function makeDragEvent(dataTransfer = makeDataTransfer()) {
  return {
    preventDefault: jest.fn(),
    dataTransfer,
    currentTarget: { contains: jest.fn().mockReturnValue(false) },
    relatedTarget: null,
  } as unknown as React.DragEvent
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useFileDrag — initial state', () => {
  it('starts with all drag IDs null', () => {
    const { result } = renderHook(() => useFileDrag(jest.fn(), jest.fn()))
    expect(result.current.draggingFileId).toBeNull()
    expect(result.current.draggingFolderId).toBeNull()
    expect(result.current.dragOverFolderId).toBeNull()
  })
})

describe('getFileDragHandlers', () => {
  it('returns draggable=true', () => {
    const { result } = renderHook(() => useFileDrag(jest.fn(), jest.fn()))
    const handlers = result.current.getFileDragHandlers(FILE)
    expect(handlers.draggable).toBe(true)
  })

  it('sets draggingFileId on dragStart', () => {
    const { result } = renderHook(() => useFileDrag(jest.fn(), jest.fn()))
    const e = makeDragEvent()
    act(() => result.current.getFileDragHandlers(FILE).onDragStart(e))
    expect(result.current.draggingFileId).toBe('f1')
  })

  it('sets file id in dataTransfer on dragStart', () => {
    const { result } = renderHook(() => useFileDrag(jest.fn(), jest.fn()))
    const dt = makeDataTransfer()
    const e = makeDragEvent(dt)
    act(() => result.current.getFileDragHandlers(FILE).onDragStart(e))
    expect(dt.setData).toHaveBeenCalledWith(FILE_DRAG_TYPE, 'f1')
  })

  it('clears draggingFileId and dragOverFolderId on dragEnd', () => {
    const { result } = renderHook(() => useFileDrag(jest.fn(), jest.fn()))
    act(() => result.current.getFileDragHandlers(FILE).onDragStart(makeDragEvent()))
    act(() => result.current.getFileDragHandlers(FILE).onDragEnd())
    expect(result.current.draggingFileId).toBeNull()
    expect(result.current.dragOverFolderId).toBeNull()
  })
})

describe('getFolderDragHandlers', () => {
  it('returns draggable=true', () => {
    const { result } = renderHook(() => useFileDrag(jest.fn(), jest.fn()))
    expect(result.current.getFolderDragHandlers(FOLDER).draggable).toBe(true)
  })

  it('sets draggingFolderId on dragStart', () => {
    const { result } = renderHook(() => useFileDrag(jest.fn(), jest.fn()))
    act(() => result.current.getFolderDragHandlers(FOLDER).onDragStart(makeDragEvent()))
    expect(result.current.draggingFolderId).toBe('fold-1')
  })

  it('clears draggingFolderId on dragEnd', () => {
    const { result } = renderHook(() => useFileDrag(jest.fn(), jest.fn()))
    act(() => result.current.getFolderDragHandlers(FOLDER).onDragStart(makeDragEvent()))
    act(() => result.current.getFolderDragHandlers(FOLDER).onDragEnd())
    expect(result.current.draggingFolderId).toBeNull()
  })
})

describe('getFolderDropHandlers', () => {
  it('sets dragOverFolderId on dragEnter for a file drag', () => {
    const { result } = renderHook(() => useFileDrag(jest.fn(), jest.fn()))
    const e = makeDragEvent(makeDataTransfer(FILE_DRAG_TYPE, 'f1'))
    act(() => result.current.getFolderDropHandlers(TARGET_FOLDER).onDragEnter(e))
    expect(result.current.dragOverFolderId).toBe('fold-target')
  })

  it('calls onMoveFile on drop', () => {
    const onMoveFile = jest.fn()
    const { result } = renderHook(() => useFileDrag(onMoveFile, jest.fn()))
    const e = makeDragEvent(makeDataTransfer(FILE_DRAG_TYPE, 'f1'))
    act(() => result.current.getFolderDropHandlers(TARGET_FOLDER).onDrop(e))
    expect(onMoveFile).toHaveBeenCalledWith('f1', 'fold-target')
  })

  it('calls onMoveFolder on drop with folder data', () => {
    const onMoveFolder = jest.fn()
    const { result } = renderHook(() => useFileDrag(jest.fn(), onMoveFolder))
    const e = makeDragEvent(makeDataTransfer(FOLDER_DRAG_TYPE, 'fold-1'))
    act(() => result.current.getFolderDropHandlers(TARGET_FOLDER).onDrop(e))
    expect(onMoveFolder).toHaveBeenCalledWith('fold-1', 'fold-target')
  })

  it('does not call onMoveFolder when dropping a folder onto itself', () => {
    const onMoveFolder = jest.fn()
    const { result } = renderHook(() => useFileDrag(jest.fn(), onMoveFolder))
    // Drop folder-1 onto folder-1
    const e = makeDragEvent(makeDataTransfer(FOLDER_DRAG_TYPE, 'fold-target'))
    act(() => result.current.getFolderDropHandlers(TARGET_FOLDER).onDrop(e))
    expect(onMoveFolder).not.toHaveBeenCalled()
  })

  it('clears dragOverFolderId on drop', () => {
    const { result } = renderHook(() => useFileDrag(jest.fn(), jest.fn()))
    const enterE = makeDragEvent(makeDataTransfer(FILE_DRAG_TYPE, 'f1'))
    act(() => result.current.getFolderDropHandlers(TARGET_FOLDER).onDragEnter(enterE))
    expect(result.current.dragOverFolderId).toBe('fold-target')
    const dropE = makeDragEvent(makeDataTransfer(FILE_DRAG_TYPE, 'f1'))
    act(() => result.current.getFolderDropHandlers(TARGET_FOLDER).onDrop(dropE))
    expect(result.current.dragOverFolderId).toBeNull()
  })

  it('ignores dragEnter for unrelated types', () => {
    const { result } = renderHook(() => useFileDrag(jest.fn(), jest.fn()))
    const e = makeDragEvent(makeDataTransfer('text/plain', 'hello'))
    act(() => result.current.getFolderDropHandlers(TARGET_FOLDER).onDragEnter(e))
    expect(result.current.dragOverFolderId).toBeNull()
  })
})
