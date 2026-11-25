import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { MdSettings } from 'react-icons/md'

// RowActionsMenu packages a row's action buttons behind a single cog-icon
// trigger for narrow layouts, where a full inline row of icon buttons (star,
// share, drive info, delete, ...) crowds the row. Pass the same interactive
// buttons already used inline as children (each wrapped in MenuRow for a
// visible label) — they keep their own behavior (including popovers like
// DriveInfoButton) unchanged, just laid out vertically in a dropdown panel.
export function RowActionsMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleOutsideClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
        title="Actions"
        aria-label="Item actions"
        className="cursor-pointer bg-transparent border-0 p-0.5 text-gray-400 hover:text-gray-700 transition-colors"
      >
        <MdSettings className="text-lg" />
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full mt-1 z-20 bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-44"
        >
          {children}
        </div>
      )}
    </div>
  )
}

// MenuRow labels a single action inside the dropdown panel, keeping the
// actual control (an existing icon button/popover) on the right. The label
// text is otherwise inert, so a click anywhere in the row that didn't land on
// the control itself is forwarded to it — the whole row becomes pressable,
// not just the icon.
export function MenuRow({ label, children }: { label: string; children: React.ReactNode }) {
  const controlRef = useRef<HTMLSpanElement>(null)

  function handleRowClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (controlRef.current?.contains(e.target as Node)) return
    const control = controlRef.current?.querySelector<HTMLElement>('button, a, [role="button"]')
    control?.click()
  }

  return (
    <div
      onClick={handleRowClick}
      className="flex items-center justify-between gap-3 px-3 py-1.5 hover:bg-gray-50 cursor-pointer"
    >
      <span className="text-xs text-gray-600 whitespace-nowrap">{label}</span>
      <span ref={controlRef} className="inline-flex items-center">{children}</span>
    </div>
  )
}
