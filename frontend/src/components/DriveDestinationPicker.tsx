import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MdChevronRight, MdFolder, MdKeyboardArrowRight, MdCheckCircle } from 'react-icons/md'
import { listRoot, getFolder } from '../api/folders'
import type { Folder } from '../types/api'

interface Props {
  // The destination drive the folder is being moved to. Its root is browsed
  // scoped to this drive; includeUnassigned is set when it's the primary drive
  // (NULL-drive rows resolve to the primary).
  driveId: string
  includeUnassigned: boolean
  // Folder ids that can't be chosen as a destination — the folder being moved
  // and its descendants would create a cycle. The moving folder is excluded from
  // the browsable lists entirely.
  excludeFolderId: string
  // Currently chosen destination (null = the drive's root).
  value: string | null
  onSelect: (destParentId: string | null, folder: Folder | null) => void
}

// DriveDestinationPicker lets the user pick the folder a relocated folder lands
// under on the destination drive — the drive's root, or any folder within it —
// by browsing down from the root. Scoped to one drive, so it only ever shows
// folders that live on the destination server & tier.
export function DriveDestinationPicker({ driveId, includeUnassigned, excludeFolderId, value, onSelect }: Props) {
  const [trail, setTrail] = useState<Folder[]>([])
  const current = trail[trail.length - 1]
  const query = useQuery({
    queryKey: current ? ['folders', current.id] : ['folders', 'root', driveId],
    queryFn: () => current
      ? getFolder(current.id)
      : listRoot({ drive: driveId, includeUnassigned, folderLimit: 200 }),
  })
  const subfolders = (query.data?.subfolders.items ?? []).filter((f) => f.id !== excludeFolderId)

  function choose(folder: Folder | null) {
    onSelect(folder?.id ?? null, folder)
  }

  const chosenLabel = value === null
    ? 'drive root'
    : (current?.id === value ? `"${current.name}"` : trail.find((f) => f.id === value)?.name ?? 'selected folder')

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-100 text-xs overflow-x-auto">
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
      <button
        type="button"
        onClick={() => choose(current ?? null)}
        className={`w-full flex items-center gap-1.5 text-xs font-medium px-2 py-1.5 cursor-pointer bg-transparent border-0 border-b border-gray-100 ${
          (value ?? null) === (current?.id ?? null) ? 'text-blue-600 bg-blue-50' : 'text-gray-600 hover:bg-gray-50'
        }`}
      >
        <MdCheckCircle className="shrink-0" />
        Move here — {current ? `"${current.name}"` : 'drive root'}
      </button>
      <div className="max-h-40 overflow-y-auto">
        {query.isLoading && <p className="px-2 py-1.5 text-xs text-gray-400">Loading…</p>}
        {!query.isLoading && subfolders.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-gray-400">No subfolders here.</p>
        )}
        {subfolders.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setTrail([...trail, f])}
            className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer bg-transparent border-0 text-left"
          >
            <span className="flex items-center gap-1.5 min-w-0">
              <MdFolder className="text-blue-400 shrink-0" />
              <span className="truncate">{f.name}</span>
            </span>
            <MdKeyboardArrowRight className="text-gray-300 shrink-0" />
          </button>
        ))}
      </div>
      <div className="px-2 py-1.5 border-t border-gray-100 text-[11px] text-gray-500">
        Destination: <span className="font-medium text-gray-700">{chosenLabel}</span>
      </div>
    </div>
  )
}
