import { useId } from 'react'

export interface LinePoint {
  x: number  // Unix ms timestamp
  y: number  // numeric value
}

interface Props {
  points: LinePoint[]
  width?: number
  height?: number
  color?: string
  formatY?: (v: number) => string
  formatX?: (ms: number) => string
}

const PAD = { top: 20, bottom: 36, left: 72, right: 16 }
const Y_TICKS = 5
const X_LABELS = 5

function defaultFormatY(v: number): string {
  const GB = 1024 ** 3
  const MB = 1024 ** 2
  if (v >= GB) return (v / GB).toFixed(2) + ' GB'
  if (v >= MB) return (v / MB).toFixed(1) + ' MB'
  return v.toFixed(0) + ' B'
}

function defaultFormatX(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function LineGraph({
  points,
  width = 640,
  height = 200,
  color = '#3b82f6',
  formatY = defaultFormatY,
  formatX = defaultFormatX,
}: Props) {
  const uid = useId()
  const gradId = `line-fill-${uid.replace(/:/g, '')}`
  const chartW = width - PAD.left - PAD.right
  const chartH = height - PAD.top - PAD.bottom

  if (points.length < 2) {
    return (
      <div
        style={{
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#9ca3af',
          fontSize: 13,
        }}
      >
        Waiting for data…
      </div>
    )
  }

  const minX = points[0].x
  const maxX = points[points.length - 1].x
  const yVals = points.map(p => p.y)
  const minY = Math.min(...yVals)
  const maxY = Math.max(...yVals)
  const rangeX = maxX - minX || 1
  const rangeY = maxY - minY || 1

  const px = (x: number) => PAD.left + ((x - minX) / rangeX) * chartW
  const py = (y: number) => PAD.top + chartH - ((y - minY) / rangeY) * chartH

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`)
    .join(' ')

  // fill path (area under line)
  const fillD =
    `M${px(points[0].x).toFixed(1)},${(PAD.top + chartH).toFixed(1)} ` +
    pathD.slice(1) +
    ` L${px(points[points.length - 1].x).toFixed(1)},${(PAD.top + chartH).toFixed(1)} Z`

  const yTickVals = Array.from({ length: Y_TICKS }, (_, i) =>
    minY + (rangeY / (Y_TICKS - 1)) * i,
  )

  const xLabelIndices = Array.from({ length: X_LABELS }, (_, i) =>
    Math.round(((points.length - 1) / (X_LABELS - 1)) * i),
  )

  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.18} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* y-axis gridlines */}
      {yTickVals.map((v, i) => {
        const y = py(v)
        return (
          <g key={i}>
            <line
              x1={PAD.left} y1={y}
              x2={width - PAD.right} y2={y}
              stroke="#e5e7eb" strokeWidth={1}
            />
            <text
              x={PAD.left - 6} y={y + 4}
              textAnchor="end" fontSize={10} fill="#9ca3af"
            >
              {formatY(v)}
            </text>
          </g>
        )
      })}

      {/* filled area */}
      <path d={fillD} fill={`url(#${gradId})`} />

      {/* line */}
      <path d={pathD} stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" />

      {/* x-axis labels */}
      {xLabelIndices.map(idx => {
        const p = points[idx]
        return (
          <text
            key={idx}
            x={px(p.x)}
            y={height - 6}
            textAnchor="middle"
            fontSize={10}
            fill="#9ca3af"
          >
            {formatX(p.x)}
          </text>
        )
      })}
    </svg>
  )
}
