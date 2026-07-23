import { renderHook, act } from '@testing-library/react'
import { useFileDrag } from '../../hooks/useFileDrag'
import type { File as ApiFile, Folder } from '../../types/api'

// ── Test data ─────────────────────────────────────────────────────────────────

const FILE: ApiFile = { id: 'f1', user_id: 'u1', name: 'doc.pdf', mime_type: 'application/pdf', size_bytes: 1024, taken_at: null, hidden: false, created_at: '', updated_at: '', folder_id: null, source: 'web' }
const FOLDER: Folder = { id: 'fold-1', user_id: 'u1', name: 'Docs', kind: 'regular', size_bytes: 0, drive_id: null, ai_recognition_enabled: false, created_at: '', updated_at: '', parent_id: null }
const TARGET_FOLDER: Folder = { id: 'fold-target', user_id: 'u1', name: 'Target', kind: 'regular', size_bytes: 0, drive_id: null, ai_recognition_enabled: false, created_at: '', updated_at: '', parent_id: null }

const FILE_DRAG_TYPE = 'application/x-apollo-file'
const FOLDER_DRAG_TYPE = 'application/x-apollo-folder'
const SELECTION_DRAG_TYPE = 'application/x-apollo-selection'

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

// Like makeDataTransfer but carries several types at once — needed to
// simulate a multi-selection drag, which sets SELECTION_DRAG_TYPE alongside
// the single-item type of whichever row was actually grabbed.
function makeMultiDataTransfer(entries: Record<string, string>) {
  const store: Record<string, string> = { ...entries }
  return {
    types: Object.keys(entries),
    effectAllowed: '',
    dropEffect: '',
    setData: jest.fn((t: string, v: string) => { store[t] = v }),
    getData: jest.fn((t: string) => store[t] ?? ''),
    setDragImage: jest.fn(),
  }
}

function makeDragEvent(dataTransfer = makeDataTransfer(), defaultPrevented = false) {
  return {
    preventDefault: jest.fn(),
    dataTransfer,
    currentTarget: { contains: jest.fn().mockReturnValue(false) },
    relatedTarget: null,
    defaultPrevented,
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

describe('getListBackgroundDropHandlers', () => {
  it('moves a file to the parent folder on drop', () => {
    const onMoveFile = jest.fn()
    const { result } = renderHook(() => useFileDrag(onMoveFile, jest.fn()))
    const e = makeDragEvent(makeDataTransfer(FILE_DRAG_TYPE, 'f1'))
    act(() => result.current.getListBackgroundDropHandlers('parent-1').onDrop(e))
    expect(onMoveFile).toHaveBeenCalledWith('f1', 'parent-1')
  })

  it('does nothing when there is no parent to move to', () => {
    const onMoveFile = jest.fn()
    const { result } = renderHook(() => useFileDrag(onMoveFile, jest.fn()))
    const e = makeDragEvent(makeDataTransfer(FILE_DRAG_TYPE, 'f1'))
    act(() => result.current.getListBackgroundDropHandlers(null).onDrop(e))
    expect(onMoveFile).not.toHaveBeenCalled()
  })

  it('ignores the drop when a more specific target (e.g. a folder row) already claimed it', () => {
    const onMoveFile = jest.fn()
    const { result } = renderHook(() => useFileDrag(onMoveFile, jest.fn()))
    const e = makeDragEvent(makeDataTransfer(FILE_DRAG_TYPE, 'f1'), /* defaultPrevented */ true)
    act(() => result.current.getListBackgroundDropHandlers('parent-1').onDrop(e))
    expect(onMoveFile).not.toHaveBeenCalled()
  })

  it('sets dragOverBackground on dragEnter and clears it on dragLeave', () => {
    const { result } = renderHook(() => useFileDrag(jest.fn(), jest.fn()))
    const enterE = makeDragEvent(makeDataTransfer(FILE_DRAG_TYPE, 'f1'))
    act(() => result.current.getListBackgroundDropHandlers('parent-1').onDragEnter(enterE))
    expect(result.current.dragOverBackground).toBe(true)
    const leaveE = makeDragEvent(makeDataTransfer(FILE_DRAG_TYPE, 'f1'))
    act(() => result.current.getListBackgroundDropHandlers('parent-1').onDragLeave(leaveE))
    expect(result.current.dragOverBackground).toBe(false)
  })

  it('does not set dragOverBackground when there is no parent to move to', () => {
    const { result } = renderHook(() => useFileDrag(jest.fn(), jest.fn()))
    const enterE = makeDragEvent(makeDataTransfer(FILE_DRAG_TYPE, 'f1'))
    act(() => result.current.getListBackgroundDropHandlers(null).onDragEnter(enterE))
    expect(result.current.dragOverBackground).toBe(false)
  })
})

describe('multi-selection drag payload', () => {
  it('attaches a selection payload on dragStart when the dragged row is part of an active selection', () => {
    const snapshot = { fileIds: ['f1', 'f2'], folderIds: ['fold-1'] }
    const getSelectionSnapshot = jest.fn(() => snapshot)
    const { result } = renderHook(() => useFileDrag(jest.fn(), jest.fn(), undefined, getSelectionSnapshot))
    const dt = makeDataTransfer()
    act(() => result.current.getFileDragHandlers(FILE).onDragStart(makeDragEvent(dt)))
    expect(dt.setData).toHaveBeenCalledWith(SELECTION_DRAG_TYPE, JSON.stringify(snapshot))
    // The single-item type is still set too, so every existing hasFile/
    // hasFolder gate on hover targets keeps working unmodified.
    expect(dt.setData).toHaveBeenCalledWith(FILE_DRAG_TYPE, 'f1')
  })

  it('does not attach a selection payload when getSelectionSnapshot returns null (not part of an active selection)', () => {
    const getSelectionSnapshot = jest.fn(() => null)
    const { result } = renderHook(() => useFileDrag(jest.fn(), jest.fn(), undefined, getSelectionSnapshot))
    const dt = makeDataTransfer()
    act(() => result.current.getFileDragHandlers(FILE).onDragStart(makeDragEvent(dt)))
    expect(dt.setData).not.toHaveBeenCalledWith(SELECTION_DRAG_TYPE, expect.anything())
  })

  it('calls onMoveMany on drop when the payload is a multi-item selection', () => {
    const onMoveMany = jest.fn()
    const { result } = renderHook(() => useFileDrag(jest.fn(), jest.fn(), undefined, undefined, onMoveMany))
    const dt = makeMultiDataTransfer({
      [FILE_DRAG_TYPE]: 'f1',
      [SELECTION_DRAG_TYPE]: JSON.stringify({ fileIds: ['f1', 'f2'], folderIds: ['fold-1'] }),
    })
    act(() => result.current.getFolderDropHandlers(TARGET_FOLDER).onDrop(makeDragEvent(dt)))
    expect(onMoveMany).toHaveBeenCalledWith(['f1', 'f2'], ['fold-1'], 'fold-target')
  })

  it('falls back to onMoveFolder when excluding the drop target leaves only one item', () => {
    const onMoveMany = jest.fn()
    const onMoveFolder = jest.fn()
    const { result } = renderHook(() => useFileDrag(jest.fn(), onMoveFolder, undefined, undefined, onMoveMany))
    // Selection is [fold-1, fold-target] — dropped onto fold-target itself,
    // which is filtered out (can't move a folder into itself), leaving just
    // fold-1 — a single remaining item resolves through the plain
    // onMoveFolder path rather than onMoveMany.
    const dt = makeMultiDataTransfer({
      [SELECTION_DRAG_TYPE]: JSON.stringify({ fileIds: [], folderIds: ['fold-1', 'fold-target'] }),
    })
    act(() => result.current.getFolderDropHandlers(TARGET_FOLDER).onDrop(makeDragEvent(dt)))
    expect(onMoveFolder).toHaveBeenCalledWith('fold-1', 'fold-target')
    expect(onMoveMany).not.toHaveBeenCalled()
  })

  it('falls back to looping onMoveFile/onMoveFolder when onMoveMany is not provided', () => {
    const onMoveFile = jest.fn()
    const onMoveFolder = jest.fn()
    const { result } = renderHook(() => useFileDrag(onMoveFile, onMoveFolder))
    const dt = makeMultiDataTransfer({
      [SELECTION_DRAG_TYPE]: JSON.stringify({ fileIds: ['f1', 'f2'], folderIds: ['fold-1'] }),
    })
    act(() => result.current.getFolderDropHandlers(TARGET_FOLDER).onDrop(makeDragEvent(dt)))
    expect(onMoveFile).toHaveBeenCalledWith('f1', 'fold-target')
    expect(onMoveFile).toHaveBeenCalledWith('f2', 'fold-target')
    expect(onMoveFolder).toHaveBeenCalledWith('fold-1', 'fold-target')
  })
})
