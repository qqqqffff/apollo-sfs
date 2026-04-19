import type { SortKey, SortState } from '../hooks/useSort'

interface Props {
  sort: SortState
  onSort: (key: SortKey) => void
}

const KEYS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'date', label: 'Date' },
  { key: 'size', label: 'Size' },
]

export function SortControls({ sort, onSort }: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 16 }}>
      <span style={{ fontSize: 12, color: '#888', marginRight: 4 }}>Sort:</span>
      {KEYS.map(({ key, label }) => {
        const active = sort.key === key
        return (
          <button
            key={key}
            onClick={() => onSort(key)}
            style={{
              padding: '3px 10px',
              borderRadius: 999,
              border: `1px solid ${active ? '#222' : '#ddd'}`,
              background: active ? '#222' : 'none',
              color: active ? '#fff' : '#555',
              fontSize: 12,
              cursor: 'pointer',
              lineHeight: 1.5,
            }}
          >
            {label}
            {active && (sort.dir === 'asc' ? ' ↑' : ' ↓')}
          </button>
        )
      })}
    </div>
  )
}
