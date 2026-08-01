import { useEffect, useState } from 'react'

interface Props {
  // Must match the hover-open delay it's previewing (useFileDrag's
  // HOVER_OPEN_DELAY_MS) so the ring finishes filling exactly as the folder
  // auto-opens.
  durationMs: number
  className?: string
}

const SIZE = 14
const STROKE = 2
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

// Small circular progress ring shown inline next to a folder/breadcrumb
// name while a drag hovers it, previewing the "spring-loaded folder"
// auto-open countdown (see useFileDrag's scheduleHoverOpen). Mounted only
// while `dragOverFolderId` matches this target, so mounting IS the signal to
// start — a plain CSS transition (empty ring -> full ring) driven off one
// state flip, rather than per-frame JS ticking.
export function HoverDonut({ durationMs, className }: Props) {
  const [filled, setFilled] = useState(false)

  useEffect(() => {
    // Flip to "filled" one frame after mount so the browser paints the empty
    // ring first — otherwise the transition has no starting state to animate
    // from and the ring just jumps straight to full.
    const raf = requestAnimationFrame(() => setFilled(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className={`shrink-0 -rotate-90 ${className ?? ''}`}
      aria-hidden="true"
    >
      <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={STROKE} />
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={filled ? 0 : CIRCUMFERENCE}
        style={{ transition: `stroke-dashoffset ${durationMs}ms linear` }}
      />
    </svg>
  )
}
