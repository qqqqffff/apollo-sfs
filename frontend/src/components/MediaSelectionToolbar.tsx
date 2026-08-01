import { useState } from 'react'
import {
  MdAdd,
  MdClose,
  MdDeleteOutline,
  MdPlaylistAddCheck,
  MdStar,
  MdStarOutline,
  MdVisibility,
  MdVisibilityOff,
} from 'react-icons/md'
import type { Folder } from '../types/api'

interface Props {
  count: number
  // True when every selected item is already favorited — flips Favorite to
  // Unfavorite, matching the file browser's SelectionToolbar coalescing.
  allFavorited: boolean
  readOnly: boolean
  // Subcollections of the current collection, offered as copy targets.
  subcollections: Folder[]
  // Set when viewing a subcollection, where pointers can be removed.
  isSubcollection: boolean
  // True while the grid still has more pages — "Select all" then means
  // "everything matching the current view", which needs a server round trip.
  canSelectAll: boolean
  isWorking?: boolean
  onSelectAll: () => void
  onToggleFavorite: () => void
  onSetHidden: (hidden: boolean) => void
  onCopyTo: (collectionId: string) => void
  onRemove: () => void
  onDelete: () => void
  onClose: () => void
}

// MediaSelectionToolbar is the media grid's counterpart to the file browser's
// SelectionToolbar: the bottom action bar shown while one or more media items
// are selected. The actions are the ones a photo grid actually needs —
// favorite, hide/unhide, copy into a subcollection, remove a pointer, delete —
// rather than the browser's move/delete pair.
export function MediaSelectionToolbar({
  count, allFavorited, readOnly, subcollections, isSubcollection, canSelectAll,
  isWorking, onSelectAll, onToggleFavorite, onSetHidden, onCopyTo, onRemove, onDelete, onClose,
}: Props) {
  const [copyOpen, setCopyOpen] = useState(false)
  if (count === 0 && !canSelectAll) return null

  return (
    <div className="fixed bottom-0 inset-x-0 z-40 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pointer-events-none">
      <div className="pointer-events-auto relative flex items-center gap-1 bg-gray-900 text-white rounded-xl shadow-2xl pl-3 pr-1.5 py-1.5 max-w-full overflow-x-auto">
        <span className="text-sm font-medium whitespace-nowrap pr-2.5 mr-1 border-r border-white/20">
          {isWorking ? 'Working…' : `${count} selected`}
        </span>

        <ToolbarButton
          icon={<MdPlaylistAddCheck className="text-lg" />}
          label="Select all"
          onClick={onSelectAll}
        />

        {count > 0 && (
          <>
            <ToolbarButton
              icon={allFavorited ? <MdStar className="text-lg text-amber-400" /> : <MdStarOutline className="text-lg" />}
              label={allFavorited ? 'Unfavorite' : 'Favorite'}
              onClick={onToggleFavorite}
            />
            {!readOnly && (
              <>
                <ToolbarButton
                  icon={<MdVisibilityOff className="text-lg" />}
                  label="Hide"
                  onClick={() => onSetHidden(true)}
                />
                <ToolbarButton
                  icon={<MdVisibility className="text-lg" />}
                  label="Unhide"
                  onClick={() => onSetHidden(false)}
                />
                {subcollections.length > 0 && (
                  <ToolbarButton
                    icon={<MdAdd className="text-lg" />}
                    label="Add to"
                    onClick={() => setCopyOpen((v) => !v)}
                  />
                )}
                {isSubcollection && (
                  <ToolbarButton
                    icon={<MdClose className="text-lg" />}
                    label="Remove"
                    onClick={onRemove}
                  />
                )}
                <ToolbarButton
                  icon={<MdDeleteOutline className="text-lg" />}
                  label="Delete"
                  onClick={onDelete}
                  danger
                />
              </>
            )}
          </>
        )}

        <button
          onClick={onClose}
          aria-label="Clear selection"
          title="Clear selection"
          className="ml-1 text-gray-300 hover:text-white cursor-pointer bg-transparent border-0 p-1.5 rounded-full hover:bg-white/10 transition-colors"
        >
          <MdClose className="text-lg" />
        </button>

        {copyOpen && subcollections.length > 0 && (
          <div className="absolute bottom-full right-2 mb-2 bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-44 max-h-60 overflow-y-auto">
            <p className="text-[10px] text-gray-400 uppercase tracking-wide px-3 py-1 m-0">Copy to</p>
            {subcollections.map((sf) => (
              <button
                key={sf.id}
                onClick={() => { onCopyTo(sf.id); setCopyOpen(false) }}
                className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer border-0 bg-transparent"
              >
                {sf.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ToolbarButton({
  icon, label, onClick, danger,
}: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-sm font-medium cursor-pointer bg-transparent border-0 transition-colors whitespace-nowrap ${
        danger ? 'text-red-300 hover:bg-red-500/20 hover:text-red-200' : 'text-white hover:bg-white/10'
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}
