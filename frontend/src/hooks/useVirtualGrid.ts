import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

export interface VirtualGridInput {
  // Total number of cells the grid represents — including any trailing
  // placeholder cells standing in for a page that hasn't arrived yet.
  itemCount: number
  cols: number
  // Height of a single cell in px, excluding the gap below it.
  rowHeight: number
  gap: number
  // The grid's positioning container. Its viewport-relative top is what the
  // window maps onto rows, so it works whether the page scrolls on <html> or
  // inside a nested scroll container.
  containerRef: RefObject<HTMLElement | null>
  // How many viewport-heights to render above and below the visible band.
  overscanViewports?: number
}

export interface VirtualGridWindow {
  // Half-open range [startIndex, endIndex) of cells worth rendering.
  startIndex: number
  endIndex: number
  // Row pitch (cell height + gap) and the container height that reserves
  // space for every row, rendered or not — this is what keeps the scrollbar
  // (and therefore the scroll position) stable as cells come and go.
  stride: number
  totalHeight: number
  rowCount: number
}

// useVirtualGrid computes which cells of a uniform grid are worth rendering
// for the current scroll position: the band actually on screen plus
// overscanViewports screenfuls above and below it. Everything outside that
// band is left unrendered, with its space held open by totalHeight — so a
// 10,000-item collection costs a few dozen DOM nodes without the scrollbar
// ever jumping.
export function useVirtualGrid({
  itemCount, cols, rowHeight, gap, containerRef, overscanViewports = 2,
}: VirtualGridInput): VirtualGridWindow {
  const safeCols = Math.max(1, cols)
  const stride = Math.max(1, rowHeight + gap)
  const rowCount = Math.ceil(itemCount / safeCols)
  const totalHeight = rowCount > 0 ? rowCount * stride - gap : 0

  const [rows, setRows] = useState({ start: 0, end: 0 })

  useEffect(() => {
    let frame = 0

    function measure() {
      frame = 0
      const el = containerRef.current
      if (!el) return
      const viewportHeight = window.innerHeight || 0
      const buffer = viewportHeight * overscanViewports
      // getBoundingClientRect().top is the container's offset from the top of
      // the viewport, so its negation is how far the grid has been scrolled.
      const scrolledPast = -el.getBoundingClientRect().top
      const start = Math.max(0, Math.floor((scrolledPast - buffer) / stride))
      const end = Math.min(rowCount, Math.max(0, Math.ceil((scrolledPast + viewportHeight + buffer) / stride)))
      setRows((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
    }

    function schedule() {
      if (!frame) frame = requestAnimationFrame(measure)
    }

    measure()
    // Capture phase so scrolling inside a nested container (which doesn't
    // bubble) is picked up too.
    window.addEventListener('scroll', schedule, { passive: true, capture: true })
    window.addEventListener('resize', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
    }
  }, [containerRef, overscanViewports, stride, rowCount])

  return {
    startIndex: rows.start * safeCols,
    endIndex: Math.min(itemCount, rows.end * safeCols),
    stride,
    totalHeight,
    rowCount,
  }
}
