import { useEffect, useRef, useState } from 'react'

interface Props {
  url: string
  onError?: () => void
  className?: string
}

// iOS WebKit caps both the size of a single <canvas> and the *total* canvas
// backing-store memory across every live canvas on the page. Rendering every
// PDF page to its own full-resolution canvas (at devicePixelRatio — up to 3 on
// phones) and keeping them all mounted blows that budget on multi-page
// documents: a later page's getContext()/render() fails, and because that
// tears down the whole preview the user just sees the "could not render" error
// — even though the file is fine (and renders on desktop, where the limits are
// far higher). Two things keep us under the budget on mobile while still
// showing every page:
//   1. cap the render scale at 2x DPR and clamp canvas dimensions, and
//   2. render lazily — only pages near the viewport hold a canvas; pages that
//      scroll far away release theirs (IntersectionObserver), so total live
//      canvas memory stays bounded no matter how long the document is.
// Environments without IntersectionObserver (tests, very old browsers) fall
// back to rendering every page eagerly. A failure on a later page is swallowed
// (that page stays blank) — only a first-page/document failure surfaces the
// error, so one bad page never blanks an otherwise-readable document.

const MAX_DPR = 2                   // retina-crisp without 3x phone DPR tripling memory
const MAX_CANVAS_DIM = 4096         // iOS per-canvas side limit (safe floor)
const MAX_CANVAS_AREA = 16_000_000  // iOS per-canvas area limit (safe floor)

export function PdfViewer({ url, onError, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const failedRef = useRef(false)

  function fail() {
    if (failedRef.current) return
    failedRef.current = true
    onError?.()
  }

  // Bumped on a debounced container-width change (e.g. orientation flip on
  // mobile) so pages re-render at the new scale.
  const [resizeTick, setResizeTick] = useState(0)
  useEffect(() => {
    const scroller = containerRef.current?.parentElement
    if (!scroller || typeof ResizeObserver === 'undefined') return
    let lastWidth = scroller.clientWidth
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const width = scroller.clientWidth
        if (Math.abs(width - lastWidth) > 20) {
          lastWidth = width
          setResizeTick((t) => t + 1)
        }
      }, 250)
    })
    observer.observe(scroller)
    return () => { observer.disconnect(); if (timer) clearTimeout(timer) }
  }, [])

  useEffect(() => {
    failedRef.current = false
    setReady(false)
    let cancelled = false
    const container = containerRef.current
    if (!container) return
    container.innerHTML = ''

    let observer: IntersectionObserver | null = null

    async function run() {
      try {
        // pdfjs-dist is pinned to v4 (package.json). v5/v6 call
        // Map.prototype.getOrInsertComputed on every render() — a 2025 feature
        // only in Safari 18.4+, so it throws on the mobile WebKit most iOS
        // devices run, breaking previews on mobile while working on desktop.
        const pdfjsLib = await import('pdfjs-dist')
        const { pdfWorkerUrl } = await import('../utils/pdfWorker')
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl()

        const doc = await pdfjsLib.getDocument({ url }).promise
        if (cancelled) return

        const targetWidth = () => container!.clientWidth || 800

        // Render one page into a fresh canvas at a mobile-safe resolution.
        async function renderPage(pageNum: number): Promise<HTMLCanvasElement> {
          const page = await doc.getPage(pageNum)
          const base = page.getViewport({ scale: 1 })
          const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
          let scale = (targetWidth() / base.width) * dpr
          // Clamp so no single canvas exceeds iOS's per-canvas limits.
          const dim = Math.max(base.width, base.height) * scale
          const area = base.width * base.height * scale * scale
          let f = 1
          if (dim > MAX_CANVAS_DIM) f = Math.min(f, MAX_CANVAS_DIM / dim)
          if (area > MAX_CANVAS_AREA) f = Math.min(f, Math.sqrt(MAX_CANVAS_AREA / area))
          scale *= f
          const viewport = page.getViewport({ scale })

          const canvas = document.createElement('canvas')
          canvas.width = Math.floor(viewport.width)
          canvas.height = Math.floor(viewport.height)
          canvas.style.width = '100%'
          canvas.style.height = 'auto'
          canvas.style.display = 'block'
          canvas.className = 'mx-auto mb-2 shadow-sm bg-white'
          const ctx = canvas.getContext('2d')
          if (!ctx) throw new Error('no 2d context')
          await page.render({ canvasContext: ctx, viewport }).promise
          return canvas
        }

        const numPages = doc.numPages

        // Eager fallback (no IntersectionObserver: tests / very old browsers).
        if (typeof IntersectionObserver !== 'function') {
          for (let n = 1; n <= numPages; n++) {
            if (cancelled) return
            try {
              const canvas = await renderPage(n)
              if (cancelled) return
              container!.appendChild(canvas)
              if (n === 1) setReady(true)
            } catch {
              if (n === 1) { fail(); return }
              // Later page failed — skip it, keep what rendered.
            }
          }
          return
        }

        // Lazy path: one placeholder per page (sized to page 1's aspect so the
        // scrollbar is correct up front), rendered/released as they scroll in
        // and out of view to keep total live canvas memory bounded.
        const rendered = new Set<number>()
        const inFlight = new Set<number>()
        const first = await doc.getPage(1)
        if (cancelled) return
        const firstVp = first.getViewport({ scale: 1 })
        const ratio = firstVp.height / firstVp.width
        const estHeight = () => `${Math.round(targetWidth() * ratio)}px`

        const holders: HTMLDivElement[] = []
        for (let n = 1; n <= numPages; n++) {
          const holder = document.createElement('div')
          holder.dataset.page = String(n)
          holder.className = 'mb-2'
          holder.style.height = estHeight()
          container!.appendChild(holder)
          holders.push(holder)
        }

        async function renderInto(pageNum: number) {
          if (cancelled || rendered.has(pageNum) || inFlight.has(pageNum)) return
          inFlight.add(pageNum)
          try {
            const canvas = await renderPage(pageNum)
            if (cancelled) return
            const holder = holders[pageNum - 1]
            holder.style.height = ''
            holder.textContent = ''
            holder.appendChild(canvas)
            rendered.add(pageNum)
            if (pageNum === 1) setReady(true)
          } catch {
            // Only a first-page failure is fatal; later pages stay blank.
            if (pageNum === 1 && !cancelled) fail()
          } finally {
            inFlight.delete(pageNum)
          }
        }

        function release(pageNum: number) {
          if (!rendered.has(pageNum)) return
          const holder = holders[pageNum - 1]
          holder.style.height = estHeight()
          holder.textContent = ''
          rendered.delete(pageNum)
        }

        // Render page 1 immediately for instant content + a ready state.
        await renderInto(1)
        if (cancelled) return

        observer = new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              const pn = Number((e.target as HTMLElement).dataset.page)
              if (e.isIntersecting) renderInto(pn)
              else release(pn)
            }
          },
          { root: container!.parentElement ?? null, rootMargin: '200% 0px' },
        )
        holders.forEach((h) => observer!.observe(h))
      } catch {
        if (!cancelled) fail()
      }
    }

    run()
    return () => {
      cancelled = true
      observer?.disconnect()
      if (container) container.innerHTML = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, resizeTick])

  return (
    <div className={`w-full overflow-auto ${className ?? 'h-full'}`}>
      {!ready && <div className="p-10 text-sm text-gray-400">Loading preview…</div>}
      <div ref={containerRef} className="max-w-3xl mx-auto px-4 py-4" />
    </div>
  )
}
