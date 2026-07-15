import { useEffect, useState } from 'react'

// DiscountBadge is the "−25%" pill shown next to a marked-down price.
export function DiscountBadge({ percent, className = '' }: { percent: number; className?: string }) {
  return (
    <span
      className={`inline-flex items-center text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 ${className}`}
    >
      −{percent}%
    </span>
  )
}

// MarkedDownPrice renders the original price struck through next to the
// current (discounted) price and the percentage badge.
export function MarkedDownPrice({
  originalLabel,
  currentLabel,
  percent,
}: {
  originalLabel: string
  currentLabel: string
  percent: number
}) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="text-gray-400 line-through text-xs">{originalLabel}</span>
      <span className="font-semibold text-green-700">{currentLabel}</span>
      <DiscountBadge percent={percent} />
    </span>
  )
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'expired'
  const s = Math.floor(ms / 1000)
  const days = Math.floor(s / 86_400)
  const hours = Math.floor((s % 86_400) / 3600)
  const mins = Math.floor((s % 3600) / 60)
  const secs = s % 60
  if (days > 0) return `${days}d ${hours}h ${mins}m ${secs}s`
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`
  return `${mins}m ${secs}s`
}

// DiscountCountdown ticks down once per second until expiresAt, then calls
// onExpired (if given) so the parent can refetch prices. Renders nothing when
// the discount has no expiry.
export function DiscountCountdown({
  expiresAt,
  onExpired,
  className = '',
}: {
  expiresAt?: string
  onExpired?: () => void
  className?: string
}) {
  const [remaining, setRemaining] = useState(() =>
    expiresAt ? new Date(expiresAt).getTime() - Date.now() : 0,
  )

  useEffect(() => {
    if (!expiresAt) return
    const end = new Date(expiresAt).getTime()
    setRemaining(end - Date.now())
    const id = setInterval(() => {
      const left = end - Date.now()
      setRemaining(left)
      if (left <= 0) {
        clearInterval(id)
        onExpired?.()
      }
    }, 1000)
    return () => clearInterval(id)
    // onExpired is intentionally not a dependency: parents pass inline
    // closures and re-subscribing every render would reset the interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt])

  if (!expiresAt) return null
  return (
    <span className={`inline-flex items-center gap-1 text-xs tabular-nums ${remaining <= 0 ? 'text-gray-400' : 'text-amber-600'} ${className}`}>
      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {remaining <= 0 ? 'Offer expired' : `Ends in ${formatRemaining(remaining)}`}
    </span>
  )
}
