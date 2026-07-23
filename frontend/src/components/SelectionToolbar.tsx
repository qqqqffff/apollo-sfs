import { MdClose, MdDeleteOutline, MdDriveFileMoveOutline, MdStar, MdStarOutline } from 'react-icons/md'

interface Props {
  count: number
  allFavorited: boolean
  onMove: () => void
  onDelete: () => void
  onToggleFavorite: () => void
  onClose: () => void
}

// SelectionToolbar is the bottom action bar shown while one or more rows are
// selected in the file browser (selection mode) — Move opens BulkMoveModal,
// Delete opens BulkDeleteConfirmModal (or fires immediately when the user has
// opted out of delete confirmations), and Favorite coalesces the whole
// selection to favorited/unfavorited depending on allFavorited.
export function SelectionToolbar({ count, allFavorited, onMove, onDelete, onToggleFavorite, onClose }: Props) {
  if (count === 0) return null

  return (
    <div className="fixed bottom-0 inset-x-0 z-40 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-1 bg-gray-900 text-white rounded-xl shadow-2xl pl-3 pr-1.5 py-1.5 max-w-full">
        <span className="text-sm font-medium whitespace-nowrap pr-2.5 mr-1 border-r border-white/20">
          {count} selected
        </span>
        <ToolbarButton icon={<MdDriveFileMoveOutline className="text-lg" />} label="Move" onClick={onMove} />
        <ToolbarButton
          icon={allFavorited ? <MdStar className="text-lg text-amber-400" /> : <MdStarOutline className="text-lg" />}
          label={allFavorited ? 'Unfavorite' : 'Favorite'}
          onClick={onToggleFavorite}
        />
        <ToolbarButton icon={<MdDeleteOutline className="text-lg" />} label="Delete" onClick={onDelete} danger />
        <button
          onClick={onClose}
          aria-label="Clear selection"
          title="Clear selection"
          className="ml-1 text-gray-300 hover:text-white cursor-pointer bg-transparent border-0 p-1.5 rounded-full hover:bg-white/10 transition-colors"
        >
          <MdClose className="text-lg" />
        </button>
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
      className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-sm font-medium cursor-pointer bg-transparent border-0 transition-colors ${
        danger ? 'text-red-300 hover:bg-red-500/20 hover:text-red-200' : 'text-white hover:bg-white/10'
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}
