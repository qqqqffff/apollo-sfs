import type { SortKey, SortState } from '../hooks/useSort'
import { MdArrowUpward, MdArrowDownward } from 'react-icons/md'

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
    <div className="flex items-center gap-1.5 mb-4">
      <span className="text-xs text-gray-400 mr-1">Sort:</span>
      {KEYS.map(({ key, label }) => {
        const active = sort.key === key
        return (
          <button
            key={key}
            onClick={() => onSort(key)}
            className={`inline-flex items-center gap-0.5 px-3 py-1 rounded-full text-xs border cursor-pointer transition-colors ${
              active
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
            }`}
          >
            {label}
            {active && (
              sort.dir === 'asc'
                ? <MdArrowUpward className="text-sm" />
                : <MdArrowDownward className="text-sm" />
            )}
          </button>
        )
      })}
    </div>
  )
}
