import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MdCheckCircle, MdChevronRight, MdEdit, MdFolder, MdKeyboardArrowRight } from 'react-icons/md'
import { rootQueryOptions, folderQueryOptions } from '../api/folders'
import type { Folder } from '../types/api'

interface Props {
  value: string
  onSelect: (prefix: string, folder: Folder | null) => void
  disabled?: boolean
}

// FolderPrefixPicker lets the user build an API key scope's path_prefix by
// browsing the real folder tree — starting at the account root and
// descending into subfolders — instead of typing it by hand. Selecting a
// folder also hands the caller the Folder object itself (see
// InfraBadges/resolveDrive) so the form can show which drive/tier the
// prefix will land on. A manual-entry fallback stays available for
// prefixes that don't correspond to an existing folder yet.
export function FolderPrefixPicker({ value, onSelect, disabled }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [manual, setManual] = useState(false)
  const [trail, setTrail] = useState<Folder[]>([])
  const current = trail[trail.length - 1]
  const query = useQuery(current ? folderQueryOptions(current.id) : rootQueryOptions)
  const subfolders = query.data?.subfolders.items ?? []

  function choose(folder: Folder | null, atTrail: Folder[]) {
    onSelect(atTrail.map((f) => f.name).join('/'), folder)
    setExpanded(false)
  }

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => { setManual(false); setExpanded((e) => !e); setTrail([]) }}
          className="flex-1 min-w-0 flex items-center gap-1.5 border border-gray-200 rounded-lg px-3 py-1.5 text-sm font-mono bg-white hover:border-gray-300 cursor-pointer text-left disabled:opacity-50"
        >
          <MdFolder className="text-gray-400 shrink-0" />
          <span className="truncate">{value || '/ (entire bucket)'}</span>
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => { setExpanded(false); setManual((m) => !m) }}
          title="Type a custom path instead"
          className="shrink-0 text-gray-400 hover:text-gray-600 bg-transparent border-0 p-1 cursor-pointer disabled:opacity-50"
        >
          <MdEdit />
        </button>
      </div>

      {manual && (
        <input
          autoFocus
          value={value}
          disabled={disabled}
          onChange={(e) => onSelect(e.target.value, null)}
          placeholder="path prefix (empty = whole bucket)"
          className="mt-2 w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      )}

      {expanded && (
        <div className="mt-2 border border-gray-200 rounded-lg bg-white overflow-hidden">
          <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-100 text-xs overflow-x-auto">
            <button
              type="button"
              onClick={() => setTrail([])}
              className="text-blue-600 hover:underline bg-transparent border-0 p-0 cursor-pointer shrink-0"
            >
              root
            </button>
            {trail.map((f, i) => (
              <span key={f.id} className="flex items-center gap-1 shrink-0">
                <MdChevronRight className="text-gray-300" />
                <button
                  type="button"
                  onClick={() => setTrail(trail.slice(0, i + 1))}
                  className="text-blue-600 hover:underline bg-transparent border-0 p-0 cursor-pointer"
                >
                  {f.name}
                </button>
              </span>
            ))}
          </div>
          <div className="px-3 py-2 border-b border-gray-100">
            <button
              type="button"
              onClick={() => choose(current ?? null, trail)}
              className="w-full flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 rounded-md px-2 py-1.5 cursor-pointer bg-transparent border-0"
            >
              <MdCheckCircle />
              Use {trail.length === 0 ? 'whole bucket (root)' : `"${trail.map((f) => f.name).join('/')}"`}
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {query.isLoading && <p className="px-3 py-2 text-xs text-gray-400">Loading…</p>}
            {!query.isLoading && subfolders.length === 0 && (
              <p className="px-3 py-2 text-xs text-gray-400">No subfolders here.</p>
            )}
            {subfolders.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setTrail([...trail, f])}
                className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer bg-transparent border-0 text-left"
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <MdFolder className="text-blue-400 shrink-0" />
                  <span className="truncate">{f.name}</span>
                </span>
                <MdKeyboardArrowRight className="text-gray-300 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
