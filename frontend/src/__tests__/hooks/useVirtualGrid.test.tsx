import { act, renderHook } from '@testing-library/react'
import { useVirtualGrid } from '../../hooks/useVirtualGrid'

// A stand-in for the grid container: the hook only ever reads its
// getBoundingClientRect().top, which is the negation of how far the grid has
// been scrolled past.
function containerAt(top: number) {
  const el = { getBoundingClientRect: () => ({ top }) } as unknown as HTMLElement
  return { current: el }
}

function setViewportHeight(px: number) {
  Object.defineProperty(window, 'innerHeight', { value: px, configurable: true, writable: true })
}

// jsdom has no rAF scheduling worth waiting on — run callbacks synchronously
// so a dispatched scroll event settles inside act().
beforeEach(() => {
  setViewportHeight(600)
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    cb(0)
    return 1
  })
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

const BASE = { cols: 4, rowHeight: 100, gap: 12, overscanViewports: 2 }

describe('useVirtualGrid', () => {
  it('reserves the full height of every row, rendered or not', () => {
    // 100 items / 4 cols = 25 rows of 112px pitch, minus the trailing gap.
    const { result } = renderHook(() =>
      useVirtualGrid({ ...BASE, itemCount: 100, containerRef: containerAt(0) }),
    )
    expect(result.current.stride).toBe(112)
    expect(result.current.rowCount).toBe(25)
    expect(result.current.totalHeight).toBe(25 * 112 - 12)
  })

  it('is zero-height with no items', () => {
    const { result } = renderHook(() =>
      useVirtualGrid({ ...BASE, itemCount: 0, containerRef: containerAt(0) }),
    )
    expect(result.current.totalHeight).toBe(0)
    expect(result.current.endIndex).toBe(0)
  })

  it('renders only the viewport plus the overscan band at the top of the list', () => {
    const { result } = renderHook(() =>
      useVirtualGrid({ ...BASE, itemCount: 1000, containerRef: containerAt(0) }),
    )
    // Unscrolled: from row 0 through ceil((600 + 1200) / 112) = 17 rows.
    expect(result.current.startIndex).toBe(0)
    expect(result.current.endIndex).toBe(17 * 4)
    // Nowhere near the whole 1000-item list.
    expect(result.current.endIndex).toBeLessThan(1000)
  })

  it('follows the scroll position, keeping a 2x viewport buffer above and below', () => {
    // Scrolled 5000px into the grid.
    const { result } = renderHook(() =>
      useVirtualGrid({ ...BASE, itemCount: 1000, containerRef: containerAt(-5000) }),
    )
    act(() => { window.dispatchEvent(new Event('scroll')) })

    const buffer = 600 * 2
    const expectedStart = Math.floor((5000 - buffer) / 112)
    const expectedEnd = Math.ceil((5000 + 600 + buffer) / 112)
    expect(result.current.startIndex).toBe(expectedStart * 4)
    expect(result.current.endIndex).toBe(expectedEnd * 4)
    // The window covers the visible band plus both buffers: 5 viewports.
    const renderedPx = (expectedEnd - expectedStart) * 112
    expect(renderedPx).toBeGreaterThanOrEqual(600 * 5)
  })

  it('never runs past the ends of the list', () => {
    const { result } = renderHook(() =>
      useVirtualGrid({ ...BASE, itemCount: 40, containerRef: containerAt(-100000) }),
    )
    act(() => { window.dispatchEvent(new Event('scroll')) })
    expect(result.current.startIndex).toBeGreaterThanOrEqual(0)
    expect(result.current.endIndex).toBeLessThanOrEqual(40)
  })

  it('clamps the last window to the item count when the final row is partial', () => {
    // 10 items over 4 columns: 3 rows, the last holding 2.
    const { result } = renderHook(() =>
      useVirtualGrid({ ...BASE, itemCount: 10, containerRef: containerAt(0) }),
    )
    expect(result.current.rowCount).toBe(3)
    expect(result.current.endIndex).toBe(10)
  })

  it('recomputes on resize', () => {
    const { result, rerender } = renderHook(
      (props: { itemCount: number }) =>
        useVirtualGrid({ ...BASE, itemCount: props.itemCount, containerRef: containerAt(0) }),
      { initialProps: { itemCount: 1000 } },
    )
    const before = result.current.endIndex

    setViewportHeight(1200)
    act(() => { window.dispatchEvent(new Event('resize')) })
    rerender({ itemCount: 1000 })

    expect(result.current.endIndex).toBeGreaterThan(before)
  })

  it('treats a zero column count as one column rather than dividing by zero', () => {
    const { result } = renderHook(() =>
      useVirtualGrid({ ...BASE, cols: 0, itemCount: 5, containerRef: containerAt(0) }),
    )
    expect(result.current.rowCount).toBe(5)
    expect(Number.isFinite(result.current.totalHeight)).toBe(true)
  })
})
