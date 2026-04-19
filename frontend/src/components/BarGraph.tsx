export interface Bar {
  label: string
  value: number   // 0–100 percentage
  color: string
  detail?: string // optional sub-label e.g. "4.2 / 8.0 GB"
}

interface Props {
  bars: Bar[]
  height?: number
}

const BAR_W = 72
const GAP = 40
const PAD = { top: 28, bottom: 52, left: 36, right: 16 }

export function BarGraph({ bars, height = 220 }: Props) {
  const chartH = height - PAD.top - PAD.bottom
  const totalW = bars.length * (BAR_W + GAP) - GAP + PAD.left + PAD.right

  const gridLines = [0, 25, 50, 75, 100]

  return (
    <svg
      width={totalW}
      height={height}
      style={{ overflow: 'visible', display: 'block' }}
    >
      {/* gridlines */}
      {gridLines.map(pct => {
        const y = PAD.top + chartH * (1 - pct / 100)
        return (
          <g key={pct}>
            <line
              x1={PAD.left} y1={y}
              x2={totalW - PAD.right} y2={y}
              stroke="#e5e7eb" strokeWidth={1}
            />
            <text
              x={PAD.left - 6} y={y + 4}
              textAnchor="end" fontSize={10} fill="#9ca3af"
            >
              {pct}%
            </text>
          </g>
        )
      })}

      {/* bars */}
      {bars.map((bar, i) => {
        const x = PAD.left + i * (BAR_W + GAP)
        const clamped = Math.max(0, Math.min(100, bar.value))
        const barH = (clamped / 100) * chartH
        const y = PAD.top + chartH - barH

        return (
          <g key={bar.label}>
            {/* bar body */}
            <rect
              x={x} y={y}
              width={BAR_W} height={Math.max(barH, 2)}
              rx={4}
              fill={bar.color}
              opacity={0.85}
            />

            {/* percentage label above bar */}
            <text
              x={x + BAR_W / 2}
              y={y - 6}
              textAnchor="middle"
              fontSize={12}
              fontWeight={600}
              fill={bar.color}
            >
              {clamped.toFixed(1)}%
            </text>

            {/* label below x-axis */}
            <text
              x={x + BAR_W / 2}
              y={PAD.top + chartH + 16}
              textAnchor="middle"
              fontSize={12}
              fill="#4b5563"
            >
              {bar.label}
            </text>

            {/* optional detail */}
            {bar.detail && (
              <text
                x={x + BAR_W / 2}
                y={PAD.top + chartH + 30}
                textAnchor="middle"
                fontSize={10}
                fill="#9ca3af"
              >
                {bar.detail}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
