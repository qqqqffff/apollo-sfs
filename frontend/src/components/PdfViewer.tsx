import { useEffect, useRef, useState } from 'react'

interface Props {
  url: string
  onError?: () => void
  className?: string
}

// Renders every page of a PDF onto its own <canvas> via pdf.js instead of
// delegating to the browser/OS's native PDF plugin. iOS WebKit (every iOS
// browser, Chrome included) only renders page 1 of a PDF embedded via
// <iframe>/<embed> — a native-viewer limitation, not something fixable by
// iframe attributes. Decoding and painting the pages ourselves sidesteps it
// and behaves identically on every engine, desktop or mobile.
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
    const container = containerRef.current?.parentElement
    if (!container) return
    let lastWidth = container.clientWidth
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const width = container.clientWidth
        if (Math.abs(width - lastWidth) > 20) {
          lastWidth = width
          setResizeTick((t) => t + 1)
        }
      }, 250)
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    failedRef.current = false
    setReady(false)
    let cancelled = false
    const container = containerRef.current
    if (!container) return
    container.innerHTML = ''

    async function render() {
      try {
        const pdfjsLib = await import('pdfjs-dist')
        const { pdfWorkerUrl } = await import('../utils/pdfWorker')
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl()

        const doc = await pdfjsLib.getDocument({ url }).promise
        if (cancelled) return

        for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
          if (cancelled) return
          const page = await doc.getPage(pageNum)
          if (cancelled) return

          const containerWidth = container!.clientWidth || 800
          const unscaledViewport = page.getViewport({ scale: 1 })
          const scale = containerWidth / unscaledViewport.width
          const dpr = window.devicePixelRatio || 1
          const viewport = page.getViewport({ scale: scale * dpr })

          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.style.width = '100%'
          canvas.style.height = 'auto'
          canvas.style.display = 'block'
          canvas.className = 'mx-auto mb-2 shadow-sm'
          const ctx = canvas.getContext('2d')
          if (!ctx) throw new Error('no 2d context')

          await page.render({ canvas, canvasContext: ctx, viewport }).promise
          if (cancelled) return

          container!.appendChild(canvas)
          if (pageNum === 1) setReady(true)
        }
      } catch {
        if (!cancelled) fail()
      }
    }

    render()
    return () => {
      cancelled = true
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
