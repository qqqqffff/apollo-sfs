import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { MdArrowBack, MdArrowForward, MdCheck, MdClose } from 'react-icons/md'
import type { TourStep } from '../data/onboardingGuides'

const SPOTLIGHT_PAD = 8
const VIEWPORT_MARGIN = 12
const TOOLBAR_RESERVE = 96 // approx height of the fixed bottom toolbar + its margin
const LOCATE_RETRY_MS = 100
const LOCATE_MAX_ATTEMPTS = 40 // ~4s
// Matches the files control panel's `lg` breakpoint (see FilesSidebar.tsx),
// below which it collapses into a slide-in drawer instead of a static column.
const SIDEBAR_BREAKPOINT = 1024

interface Props {
  eyebrow: string
  steps: TourStep[]
  onClose: () => void
}

// A found element can still be unusable as a spotlight target: zero-sized,
// or off-screen because it's inside the files sidebar drawer mid-transition
// (or not yet opened at all — see needsSidebar above).
function isRectVisible(r: DOMRect): boolean {
  return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 &&
    r.left < window.innerWidth && r.top < window.innerHeight
}

// OnboardingSpotlightTour is a guided, stepped tour that dims the screen and
// cuts a highlight out around the real UI element each step is about (found
// via `data-tour="<target>"`), with a tooltip next to it and step controls
// in a bottom toolbar (mirrors SelectionToolbar's look). Steps can point at
// elements on different pages — see TourStep.route — the tour navigates
// there automatically and waits for the element to mount.
export function OnboardingSpotlightTour({ eyebrow, steps, onClose }: Props) {
  const [stepIndex, setStepIndex] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [found, setFound] = useState(false)
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  const step = steps[stepIndex]
  const isLastStep = stepIndex === steps.length - 1

  // Locate (and, if needed, navigate to) this step's target element. Retries
  // briefly since the target page may still be fetching data when the tour
  // arrives there.
  useEffect(() => {
    let cancelled = false
    let attempts = 0
    setFound(false)
    setRect(null)

    if (step.route && pathname !== step.route) {
      navigate({ to: step.route as never })
    }

    function tryLocate() {
      if (cancelled) return
      // The target lives inside the files control panel, which is a
      // slide-in drawer (hidden off-screen, not unmounted) below the `lg`
      // breakpoint — open it first so the highlight lands somewhere visible.
      if (step.needsSidebar && window.innerWidth < SIDEBAR_BREAKPOINT) {
        document.querySelector<HTMLElement>('[data-tour="sidebar-toggle"]')?.click()
      }
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
      // The files control panel's drawer content is always mounted, just
      // translated off-screen while closed — so a found element still needs
      // a visibility check, both for that case and for the sidebar's ~200ms
      // open transition still being mid-flight.
      if (el && isRectVisible(el.getBoundingClientRect())) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        requestAnimationFrame(() => {
          if (cancelled) return
          setRect(el.getBoundingClientRect())
          setFound(true)
        })
        return
      }
      attempts += 1
      if (attempts < LOCATE_MAX_ATTEMPTS) {
        setTimeout(tryLocate, LOCATE_RETRY_MS)
      }
    }
    tryLocate()

    return () => { cancelled = true }
  }, [step, pathname, navigate])

  // Keep the highlight aligned with its target while the step is active
  // (layout shifts, window resizes, page scrolls).
  useEffect(() => {
    if (!found) return
    function update() {
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
      if (el) setRect(el.getBoundingClientRect())
    }
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [found, step])

  // Position the tooltip relative to the target rect, measured against its
  // own rendered size so it never overflows the viewport or the reserved
  // toolbar strip at the bottom.
  useLayoutEffect(() => {
    const ttEl = tooltipRef.current
    if (!ttEl) return
    const ttW = ttEl.offsetWidth
    const ttH = ttEl.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight - TOOLBAR_RESERVE

    if (!rect) {
      setTooltipPos({
        top: Math.max(VIEWPORT_MARGIN, (vh - ttH) / 2),
        left: Math.max(VIEWPORT_MARGIN, (vw - ttW) / 2),
      })
      return
    }

    let top: number
    let left = rect.left
    if (rect.bottom + VIEWPORT_MARGIN + ttH <= vh) {
      top = rect.bottom + VIEWPORT_MARGIN
    } else if (rect.top - VIEWPORT_MARGIN - ttH >= 0) {
      top = rect.top - VIEWPORT_MARGIN - ttH
    } else if (rect.right + VIEWPORT_MARGIN + ttW <= vw) {
      top = Math.max(VIEWPORT_MARGIN, Math.min(rect.top, vh - ttH))
      left = rect.right + VIEWPORT_MARGIN
    } else if (rect.left - VIEWPORT_MARGIN - ttW >= 0) {
      top = Math.max(VIEWPORT_MARGIN, Math.min(rect.top, vh - ttH))
      left = rect.left - VIEWPORT_MARGIN - ttW
    } else {
      top = Math.max(VIEWPORT_MARGIN, (vh - ttH) / 2)
      left = Math.max(VIEWPORT_MARGIN, (vw - ttW) / 2)
    }

    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - ttW - VIEWPORT_MARGIN))
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - ttH))
    setTooltipPos({ top, left })
  }, [rect, step])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  function goNext() {
    if (isLastStep) onClose()
    else setStepIndex((s) => s + 1)
  }

  return (
    <>
      {/* Blocks interaction with the real page underneath while the tour is
          active — the dim/highlight visuals themselves come from the
          spotlight box below, which is pointer-events-none. z-[65]+ (rather
          than the z-40/z-50 most of the app's overlays use) so the tour still
          renders on top of the files sidebar drawer (z-[55]/z-[60]) when a
          step opens it — see needsSidebar. */}
      <div className="fixed inset-0 z-[65]" />

      {found && rect ? (
        <div
          className="fixed z-[65] rounded-lg pointer-events-none transition-all duration-200 ease-out"
          style={{
            top: rect.top - SPOTLIGHT_PAD,
            left: rect.left - SPOTLIGHT_PAD,
            width: rect.width + SPOTLIGHT_PAD * 2,
            height: rect.height + SPOTLIGHT_PAD * 2,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.65)',
            outline: '2px solid #3b82f6',
            outlineOffset: '2px',
          }}
        />
      ) : (
        <div className="fixed inset-0 z-[65] bg-black/65 pointer-events-none" />
      )}

      <div
        ref={tooltipRef}
        className="fixed z-[65] bg-white rounded-xl shadow-xl border border-gray-200 w-[min(22rem,calc(100vw-1.5rem))] p-4"
        style={tooltipPos ? { top: tooltipPos.top, left: tooltipPos.left } : { visibility: 'hidden', top: 0, left: 0 }}
      >
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-blue-600 uppercase tracking-wider m-0 mb-0.5">
              {eyebrow}
            </p>
            <h2 className="text-sm font-semibold text-gray-900 m-0">{step.title}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-600 transition-colors cursor-pointer bg-transparent border-0 p-0.5 shrink-0"
          >
            <MdClose className="text-lg" />
          </button>
        </div>
        <div className="text-sm text-gray-700 leading-relaxed">{step.body}</div>
      </div>

      <div className="fixed bottom-0 inset-x-0 z-[70] flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-1 bg-gray-900 text-white rounded-xl shadow-2xl pl-3 pr-1.5 py-1.5 max-w-full">
          <span className="text-sm font-medium whitespace-nowrap pr-2.5 mr-1 border-r border-white/20">
            Step {stepIndex + 1} of {steps.length}
          </span>
          <div className="flex items-center gap-1.5 pr-2.5 mr-1 border-r border-white/20">
            {steps.map((_, i) => (
              <button
                key={i}
                onClick={() => setStepIndex(i)}
                aria-label={`Go to step ${i + 1}`}
                aria-current={i === stepIndex}
                className={`w-1.5 h-1.5 rounded-full cursor-pointer border-0 p-0 transition-colors ${
                  i === stepIndex ? 'bg-blue-400' : 'bg-white/25 hover:bg-white/40'
                }`}
              />
            ))}
          </div>
          {stepIndex > 0 && (
            <ToolbarButton icon={<MdArrowBack className="text-lg" />} label="Back" onClick={() => setStepIndex((s) => s - 1)} />
          )}
          <ToolbarButton
            icon={isLastStep ? <MdCheck className="text-lg" /> : <MdArrowForward className="text-lg" />}
            label={isLastStep ? 'Finish' : 'Next'}
            onClick={goNext}
          />
          <ToolbarButton label="Skip" onClick={onClose} />
          <button
            onClick={onClose}
            aria-label="Close guide"
            title="Close guide"
            className="ml-1 text-gray-300 hover:text-white cursor-pointer bg-transparent border-0 p-1.5 rounded-full hover:bg-white/10 transition-colors"
          >
            <MdClose className="text-lg" />
          </button>
        </div>
      </div>
    </>
  )
}

function ToolbarButton({
  icon, label, onClick,
}: { icon?: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-sm font-medium cursor-pointer bg-transparent border-0 text-white hover:bg-white/10 transition-colors whitespace-nowrap"
    >
      {icon}
      <span className={icon ? 'hidden sm:inline' : undefined}>{label}</span>
    </button>
  )
}
