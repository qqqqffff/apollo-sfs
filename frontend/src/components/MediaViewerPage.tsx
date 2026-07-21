import { useEffect, useRef, useState } from 'react'
import { MdChevronLeft, MdChevronRight, MdClose, MdDownload, MdMovie, MdStar, MdStarOutline } from 'react-icons/md'
import { downloadUrl, previewUrl, streamUrl } from '../api/files'
import type { File } from '../types/api'

interface Props {
  files: File[]
  activeFileId: string
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onFetchNextPage: () => void
  favoriteFileIds: Set<string>
  onToggleFavorite: (fileId: string) => void
  // Fired (replace-style) as the user scrolls to a new item, so the URL
  // tracks the currently-viewed file without piling up history entries.
  onNavigate: (fileId: string) => void
  onClose: () => void
}

// MediaViewerPage is a full-viewport, Apple-Photos-style stand-in for the
// generic FilePreviewModal when previewing an item from inside a media
// collection: horizontal scroll-snap through every loaded item (paging in
// more as the end nears) instead of a single centered dialog, with quick
// favorite/download actions fixed over the top-right corner.
export function MediaViewerPage({
  files, activeFileId, hasNextPage, isFetchingNextPage, onFetchNextPage,
  favoriteFileIds, onToggleFavorite, onNavigate, onClose,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initialIndex = Math.max(0, files.findIndex((f) => f.id === activeFileId))
  const [index, setIndex] = useState(initialIndex)

  // Jump to the requested item on mount without an animated scroll.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollLeft = initialIndex * el.clientWidth
    // Only on mount — subsequent index changes are driven by user scroll/nav.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') goTo(index - 1)
      else if (e.key === 'ArrowRight') goTo(index + 1)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, files.length])

  function goTo(next: number) {
    const el = scrollRef.current
    if (!el || next < 0 || next >= files.length) return
    el.scrollTo({ left: next * el.clientWidth, behavior: 'smooth' })
  }

  function handleScroll() {
    const el = scrollRef.current
    if (!el || el.clientWidth === 0) return
    const nextIndex = Math.round(el.scrollLeft / el.clientWidth)
    if (nextIndex !== index && nextIndex >= 0 && nextIndex < files.length) {
      setIndex(nextIndex)
    }
    if (nextIndex >= files.length - 3 && hasNextPage && !isFetchingNextPage) {
      onFetchNextPage()
    }
    // Debounce the URL sync until scrolling settles so we don't fire a
    // navigation for every intermediate frame while flicking through.
    if (settleTimer.current) clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => {
      const settledIndex = Math.round(el.scrollLeft / el.clientWidth)
      const file = files[settledIndex]
      if (file) onNavigate(file.id)
    }, 150)
  }

  useEffect(() => () => { if (settleTimer.current) clearTimeout(settleTimer.current) }, [])

  const current = files[index]

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* Top bar — close, filename/counter, quick actions (favorite/download) */}
      <div className="absolute top-0 inset-x-0 z-10 flex items-center justify-between gap-3 px-4 py-3 bg-gradient-to-b from-black/70 to-transparent">
        <button
          onClick={onClose}
          aria-label="Close"
          className="flex items-center justify-center w-9 h-9 shrink-0 rounded-full text-white/90 hover:bg-white/10 cursor-pointer bg-transparent border-0 transition-colors"
        >
          <MdClose className="text-2xl" />
        </button>
        <div className="min-w-0 flex-1 text-center">
          {current && (
            <>
              <p className="text-sm text-white/90 truncate m-0">{current.name}</p>
              <p className="text-[11px] text-white/50 m-0">{index + 1} of {files.length}</p>
            </>
          )}
        </div>
        {current && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => onToggleFavorite(current.id)}
              title={favoriteFileIds.has(current.id) ? 'Remove from favorites' : 'Add to favorites'}
              aria-label="Toggle favorite"
              className={`flex items-center justify-center w-9 h-9 rounded-full cursor-pointer bg-transparent border-0 transition-colors ${
                favoriteFileIds.has(current.id) ? 'text-amber-400 hover:bg-white/10' : 'text-white/90 hover:bg-white/10'
              }`}
            >
              {favoriteFileIds.has(current.id) ? <MdStar className="text-xl" /> : <MdStarOutline className="text-xl" />}
            </button>
            <a
              href={downloadUrl(current.id)}
              title="Download"
              aria-label="Download"
              className="flex items-center justify-center w-9 h-9 rounded-full text-white/90 hover:bg-white/10 transition-colors"
            >
              <MdDownload className="text-xl" />
            </a>
          </div>
        )}
      </div>

      {/* Desktop prev/next affordances — touch users swipe instead. */}
      {index > 0 && (
        <button
          onClick={() => goTo(index - 1)}
          aria-label="Previous"
          className="hidden sm:flex absolute left-2 top-1/2 -translate-y-1/2 z-10 items-center justify-center w-10 h-10 rounded-full text-white/80 hover:bg-white/10 cursor-pointer bg-black/20 border-0 transition-colors"
        >
          <MdChevronLeft className="text-3xl" />
        </button>
      )}
      {index < files.length - 1 && (
        <button
          onClick={() => goTo(index + 1)}
          aria-label="Next"
          className="hidden sm:flex absolute right-2 top-1/2 -translate-y-1/2 z-10 items-center justify-center w-10 h-10 rounded-full text-white/80 hover:bg-white/10 cursor-pointer bg-black/20 border-0 transition-colors"
        >
          <MdChevronRight className="text-3xl" />
        </button>
      )}

      {/* Horizontal scroll-snap gallery through the whole loaded collection */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 flex overflow-x-auto snap-x snap-mandatory [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: 'none' }}
      >
        {files.map((f) => (
          <div key={f.id} className="w-full h-full shrink-0 snap-center flex items-center justify-center">
            {f.mime_type.startsWith('image/') ? (
              <img src={previewUrl(f.id)} alt={f.name} loading="lazy" className="max-w-full max-h-full object-contain" />
            ) : f.mime_type.startsWith('video/') ? (
              <video
                src={streamUrl(f.id)}
                controls
                playsInline
                preload="metadata"
                className="max-w-full max-h-full object-contain"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-white/60">
                <MdMovie className="text-6xl" />
                <span className="text-sm">{f.name}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
