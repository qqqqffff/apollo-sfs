import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MdChevronRight, MdFolder, MdKeyboardArrowRight, MdCheckCircle, MdCheckCircleOutline } from 'react-icons/md'
import { listRoot, getFolder } from '../api/folders'
import type { Folder } from '../types/api'

interface Props {
  // The drive the moved items already live on — same-drive moves only (the
  // backend's plain reparent endpoints reject cross-drive moves; that's what
  // the separate drive-migration flow, and DriveDestinationPicker, are for).
  driveId: string
  includeUnassigned: boolean
  // Folder ids that can't be chosen as a destination — every selected folder
  // (and, by not being listed, their descendants) being moved, so nothing can
  // land inside itself.
  excludeFolderIds: string[]
  // Currently chosen destination. Unlike DriveDestinationPicker, root is never
  // a valid choice here — the plain move endpoints always require a real
  // folder id — so this is null only before the user has picked one.
  value: string | null
  onSelect: (folderId: string, folder: Folder) => void
}

// FolderTreePicker lets the user browse down from a drive's root and pick a
// real folder to move files/folders into. Same browsing UI as
// DriveDestinationPicker (breadcrumb trail, subfolder list, "Move here"
// button) but root itself is never selectable.
export function FolderTreePicker({ driveId, includeUnassigned, excludeFolderIds, value, onSelect }: Props) {
  const [trail, setTrail] = useState<Folder[]>([])
  const current = trail[trail.length - 1]
  const query = useQuery({
    queryKey: current ? ['folders', current.id] : ['folders', 'root', driveId],
    queryFn: () => current
      ? getFolder(current.id)
      : listRoot({ drive: driveId, includeUnassigned, folderLimit: 200 }),
  })
  const subfolders = (query.data?.subfolders.items ?? []).filter((f) => !excludeFolderIds.includes(f.id))

  const chosenLabel = value === null
    ? 'none yet — choose a folder below'
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
      {current && (
        <button
          type="button"
          onClick={() => onSelect(current.id, current)}
          className={`w-full flex items-center gap-1.5 text-xs font-medium px-2 py-1.5 cursor-pointer bg-transparent border-0 border-b border-gray-100 ${
            value === current.id ? 'text-blue-600 bg-blue-50' : 'text-gray-600 hover:bg-gray-50'
          }`}
        >
          {value === current.id ? <MdCheckCircle className="shrink-0" /> : <MdCheckCircleOutline className="shrink-0" />}
          Move here — "{current.name}"
        </button>
      )}
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
