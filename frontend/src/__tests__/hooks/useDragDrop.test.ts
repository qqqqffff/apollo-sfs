import { renderHook, act } from '@testing-library/react'
import { useDragDrop } from '../../hooks/useDragDrop'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDragEvent(types: string[], files: File[] = []): DragEvent {
  const dt = {
    types,
    files: { length: files.length, ...Object.fromEntries(files.map((f, i) => [i, f])), [Symbol.iterator]: files[Symbol.iterator].bind(files) },
    dropEffect: '',
  }
  return {
    preventDefault: jest.fn(),
    dataTransfer: dt,
  } as unknown as DragEvent
}

function fireDoc(event: string, e: DragEvent) {
  document.dispatchEvent(Object.assign(new Event(event), e))
}

function triggerDragEnter(types = ['Files']) {
  document.dispatchEvent(Object.assign(new Event('dragenter'), makeDragEvent(types)))
}

function triggerDragLeave() {
  document.dispatchEvent(new Event('dragleave'))
}

function triggerDrop(files: File[] = [new File(['x'], 'test.txt')]) {
  const e = makeDragEvent(['Files'], files)
  document.dispatchEvent(Object.assign(new Event('drop'), e))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useDragDrop', () => {
  it('starts with isDragging=false', () => {
    const { result } = renderHook(() => useDragDrop(jest.fn()))
    expect(result.current.isDragging).toBe(false)
  })

  it('sets isDragging=true on dragenter with Files type', () => {
    const { result } = renderHook(() => useDragDrop(jest.fn()))
    act(() => triggerDragEnter(['Files']))
    expect(result.current.isDragging).toBe(true)
  })

  it('ignores dragenter without Files type', () => {
    const { result } = renderHook(() => useDragDrop(jest.fn()))
    act(() => triggerDragEnter(['text/plain']))
    expect(result.current.isDragging).toBe(false)
  })

  it('stays true across nested enter/leave (counter-based)', () => {
    const { result } = renderHook(() => useDragDrop(jest.fn()))
    act(() => {
      triggerDragEnter()  // count = 1
      triggerDragEnter()  // count = 2
      triggerDragLeave()  // count = 1 — still dragging
    })
    expect(result.current.isDragging).toBe(true)
  })

  it('sets isDragging=false when leave count reaches 0', () => {
    const { result } = renderHook(() => useDragDrop(jest.fn()))
    act(() => {
      triggerDragEnter()  // count = 1
      triggerDragLeave()  // count = 0
    })
    expect(result.current.isDragging).toBe(false)
  })

  it('sets isDragging=false on drop', () => {
    const { result } = renderHook(() => useDragDrop(jest.fn()))
    act(() => {
      triggerDragEnter()
      triggerDrop()
    })
    expect(result.current.isDragging).toBe(false)
  })

  it('calls onFiles with the dropped files', () => {
    const onFiles = jest.fn()
    renderHook(() => useDragDrop(onFiles))
    const file = new File(['content'], 'photo.png')
    act(() => triggerDrop([file]))
    expect(onFiles).toHaveBeenCalledWith([file])
  })

  it('does not call onFiles when no files are dropped', () => {
    const onFiles = jest.fn()
    renderHook(() => useDragDrop(onFiles))
    act(() => triggerDrop([]))
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('cancelDrag sets isDragging=false immediately', () => {
    const { result } = renderHook(() => useDragDrop(jest.fn()))
    act(() => triggerDragEnter())
    expect(result.current.isDragging).toBe(true)
    act(() => result.current.cancelDrag())
    expect(result.current.isDragging).toBe(false)
  })

  it('uses the latest onFiles callback without re-attaching listeners', () => {
    const first = jest.fn()
    const second = jest.fn()
    const { rerender } = renderHook(({ cb }) => useDragDrop(cb), { initialProps: { cb: first } })
    rerender({ cb: second })
    const file = new File(['x'], 'a.txt')
    act(() => triggerDrop([file]))
    expect(second).toHaveBeenCalledWith([file])
    expect(first).not.toHaveBeenCalled()
  })

  it('removes event listeners on unmount', () => {
    const onFiles = jest.fn()
    const { unmount } = renderHook(() => useDragDrop(onFiles))
    unmount()
    act(() => triggerDrop([new File(['x'], 'a.txt')]))
    expect(onFiles).not.toHaveBeenCalled()
  })
})
