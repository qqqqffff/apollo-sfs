import { useQuery } from '@tanstack/react-query'
import { useLayoutEffect, useRef, useState } from 'react'
import { MdChevronRight } from 'react-icons/md'
import { ancestorsQueryOptions } from '../api/folders'
import type { Folder } from '../types/api'

interface Props {
  folderId: string | 'root'
  onNavigate: (folderId: string | undefined) => void
  // Optional trailing slot — the share-directory button sits here on premium
  // accounts so the breadcrumb row stays as one visual unit.
  trailing?: React.ReactNode
}

// FolderBreadcrumb renders the clickable path from root → current folder.
// The leading "." is always the root sentinel. When the path doesn't fit
// the available width, the leftmost segments collapse into a single ".."
// button that navigates to the immediate parent of the current folder.
export function FolderBreadcrumb({ folderId, onNavigate, trailing }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [available, setAvailable] = useState<number>(0)
  const isRoot = folderId === 'root'
  const { data, isLoading } = useQuery({
    ...ancestorsQueryOptions(folderId),
    enabled: !isRoot,
  })

  const ancestors: Folder[] = data?.ancestors ?? []

  // Track container width so we know when to truncate. ResizeObserver fires
  // on initial mount and any subsequent layout change.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    setAvailable(el.clientWidth)
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth
      setAvailable(Math.floor(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Estimate how many right-most ancestor segments fit. We approximate with
  // ~10 px per character (text-sm + chevron gap) which is conservative
  // enough to avoid overflow on the cramped end of the spectrum without
  // being so pessimistic that the breadcrumb collapses unnecessarily.
  const segments = isRoot ? [] : ancestors
  const totalChars = segments.reduce((n, f) => n + f.name.length + 3, 0) + 16 // 16 = leading "."
  const fits = available === 0 || totalChars * 10 <= available

  // Tail = always show: current folder. Beyond that, fit as many as we can
  // counting backwards from the leaf.
  let visible = segments
  let truncated = false
  if (!fits && segments.length > 1) {
    const minTail = 1 // always keep the current folder
    let keep = minTail
    const leaf = segments[segments.length - 1]
    let chars = 16 + (leaf ? leaf.name.length : 0) + 6 // "." + leaf + ".." section
    for (let i = segments.length - 2; i >= 0; i--) {
      chars += segments[i].name.length + 3
      if (chars * 10 > available) break
      keep++
    }
    visible = segments.slice(segments.length - keep)
    truncated = keep < segments.length
  }

  const parentOfCurrent = segments.length >= 2 ? segments[segments.length - 2] : undefined

  return (
    <div
      ref={containerRef}
      className="flex items-center gap-1 text-sm text-gray-600 mb-5 min-w-0"
    >
      <Crumb
        label="."
        title="Root"
        clickable={!isRoot}
        onClick={() => onNavigate(undefined)}
        current={isRoot}
      />
      {!isRoot && truncated && parentOfCurrent && (
        <>
          <Sep />
          <Crumb
            label=".."
            title="Up one level"
            clickable
            onClick={() => onNavigate(parentOfCurrent.id)}
          />
        </>
      )}
      {!isRoot && !isLoading && visible.map((f, i) => {
        const isCurrent = i === visible.length - 1
        return (
          <span key={f.id} className="flex items-center gap-1 min-w-0">
            <Sep />
            <Crumb
              label={f.name}
              title={f.name}
              clickable={!isCurrent}
              onClick={() => onNavigate(f.id)}
              current={isCurrent}
            />
          </span>
        )
      })}
      {trailing && <div className="ml-3 flex items-center">{trailing}</div>}
    </div>
  )
}

function Crumb({
  label, title, onClick, clickable, current,
}: { label: string; title: string; onClick: () => void; clickable: boolean; current?: boolean }) {
  if (!clickable) {
    return (
      <span
        title={title}
        className={`truncate ${current ? 'font-semibold text-gray-900' : 'text-gray-500'}`}
      >
        {label}
      </span>
    )
  }
  return (
    <button
      onClick={onClick}
      title={title}
      className="truncate bg-transparent border-0 p-0 cursor-pointer text-blue-600 hover:underline"
    >
      {label}
    </button>
  )
}

function Sep() {
  return <MdChevronRight className="text-gray-300 shrink-0" />
}
