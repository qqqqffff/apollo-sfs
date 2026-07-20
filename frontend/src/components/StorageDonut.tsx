// StorageDonut summarises overall server storage: the Fast (NVMe) vs Standard
// (HDD) capacity split, and how much of each tier's capacity is allocated to
// user quotas. Hand-rolled SVG to match LineGraph's style (no chart library).

export interface DonutTier {
  capacityBytes: number
  allocatedBytes: number
}

interface Props {
  fast: DonutTier
  standard: DonutTier
}

const SIZE = 180
const STROKE = 24
const R = (SIZE - STROKE) / 2
const CX = SIZE / 2
const CY = SIZE / 2
const CIRCUMFERENCE = 2 * Math.PI * R
const GAP = 3 // px gap between the two arcs, at each of the two junctions

const FAST_COLOR = '#10b981'     // emerald-500 — matches the existing "Fast" badge colour
const STANDARD_COLOR = '#3b82f6' // blue-500 — matches the app's primary/action colour
const TRACK_COLOR = '#e5e7eb'    // gray-200

function allocPct(tier: DonutTier): number {
  return tier.capacityBytes > 0 ? (tier.allocatedBytes / tier.capacityBytes) * 100 : 0
}

function fmtCapacity(bytes: number): string {
  const GB = 1024 ** 3
  const gb = bytes / GB
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(0)} GB`
}

export function StorageDonut({ fast, standard }: Props) {
  const totalCapacity = fast.capacityBytes + standard.capacityBytes
  const fastFrac = totalCapacity > 0 ? fast.capacityBytes / totalCapacity : 0
  const standardFrac = totalCapacity > 0 ? standard.capacityBytes / totalCapacity : 0

  const fastLen = Math.max(0, fastFrac * CIRCUMFERENCE - (standardFrac > 0 ? GAP : 0))
  const standardLen = Math.max(0, standardFrac * CIRCUMFERENCE - (fastFrac > 0 ? GAP : 0))

  return (
    <div className="flex flex-col sm:flex-row items-center gap-6">
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} style={{ display: 'block' }}>
          <g transform={`rotate(-90 ${CX} ${CY})`}>
            {totalCapacity === 0 ? (
              <circle cx={CX} cy={CY} r={R} fill="none" stroke={TRACK_COLOR} strokeWidth={STROKE} />
            ) : (
              <>
                <circle
                  cx={CX} cy={CY} r={R} fill="none"
                  stroke={FAST_COLOR} strokeWidth={STROKE} strokeLinecap="round"
                  strokeDasharray={`${fastLen} ${CIRCUMFERENCE - fastLen}`}
                />
                <circle
                  cx={CX} cy={CY} r={R} fill="none"
                  stroke={STANDARD_COLOR} strokeWidth={STROKE} strokeLinecap="round"
                  strokeDasharray={`${standardLen} ${CIRCUMFERENCE - standardLen}`}
                  strokeDashoffset={-(fastFrac * CIRCUMFERENCE)}
                />
              </>
            )}
          </g>
        </svg>
        {/* Center legend — the allocation percentage is the number this chart leads with. */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
          {totalCapacity === 0 ? (
            <span className="text-xs text-gray-400 px-4 text-center">No drives synced</span>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: FAST_COLOR }} />
                <span className="text-xs text-gray-500">Fast</span>
                <span className="text-sm font-semibold text-gray-900 tabular-nums">{allocPct(fast).toFixed(0)}%</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: STANDARD_COLOR }} />
                <span className="text-xs text-gray-500">Standard</span>
                <span className="text-sm font-semibold text-gray-900 tabular-nums">{allocPct(standard).toFixed(0)}%</span>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: FAST_COLOR }} />
          <span className="text-gray-700 font-medium">Fast</span>
          <span className="text-gray-400">{fmtCapacity(fast.allocatedBytes)} allocated / {fmtCapacity(fast.capacityBytes)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: STANDARD_COLOR }} />
          <span className="text-gray-700 font-medium">Standard</span>
          <span className="text-gray-400">{fmtCapacity(standard.allocatedBytes)} allocated / {fmtCapacity(standard.capacityBytes)}</span>
        </div>
      </div>
    </div>
  )
}
