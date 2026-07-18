import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MdArrowBack,
  MdAutoAwesome,
  MdCheck,
  MdClose,
  MdDelete,
  MdEdit,
  MdMergeType,
  MdMovie,
  MdPets,
  MdPhoto,
} from 'react-icons/md'
import {
  deleteGroup,
  detectionThumbUrl,
  getGroupFiles,
  mergeGroups,
  recognitionGroupsQueryOptions,
  recognitionStatusQueryOptions,
  renameGroup,
} from '../api/recognition'
import { previewUrl } from '../api/files'
import { useNotification } from '../context/NotificationContext'
import type { RecognitionGroup, RecognitionKind } from '../types/api'

interface Props {
  collectionId: string
  // Deep link from a search result: open directly on this group's files.
  initialGroupId?: string
  onOpenFile: (id: string) => void
  onClose: () => void
}

type KindFilter = RecognitionKind | 'all'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function groupLabel(g: RecognitionGroup): string {
  return g.user_label ?? g.auto_label
}

// GroupCover renders a face/pet crop when one is stored, otherwise the first
// member file's preview (object groups, or crop-less detections).
function GroupCover({ group }: { group: RecognitionGroup }) {
  const src =
    group.kind !== 'object' && group.cover_detection_id
      ? detectionThumbUrl(group.cover_detection_id)
      : group.cover_file_id
        ? previewUrl(group.cover_file_id)
        : null
  if (!src) {
    return (
      <div className="w-full h-full flex items-center justify-center text-gray-300">
        {group.kind === 'pet' ? <MdPets className="text-3xl" /> : <MdPhoto className="text-3xl" />}
      </div>
    )
  }
  return <img src={src} alt={groupLabel(group)} loading="lazy" className="w-full h-full object-cover" />
}

// RecognitionGroupsModal is the tabbed group browser: All groups (with
// Faces/Pets/Objects filters, inline rename, multi-select merge) and a
// Labeled sub-tab (rename/delete of every user-labeled group). Clicking a
// group opens its paginated file grid in place.
export function RecognitionGroupsModal({ collectionId, initialGroupId, onOpenFile, onClose }: Props) {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const [tab, setTab] = useState<'all' | 'labeled'>('all')
  const [kind, setKind] = useState<KindFilter>('all')
  const [openGroupId, setOpenGroupId] = useState<string | null>(initialGroupId ?? null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pendingDelete, setPendingDelete] = useState<RecognitionGroup | null>(null)

  const { data: status } = useQuery(recognitionStatusQueryOptions(collectionId))
  const { data: groupsData, isLoading } = useQuery(
    recognitionGroupsQueryOptions(collectionId, kind === 'all' ? undefined : kind, tab === 'labeled'),
  )
  const groups = useMemo(() => groupsData?.groups ?? [], [groupsData])
  const openGroup = groups.find((g) => g.id === openGroupId) ?? null

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handler)
      document.body.style.overflow = ''
    }
  }, [onClose])

  function invalidateGroups() {
    queryClient.invalidateQueries({ queryKey: ['recognition', collectionId] })
  }

  const renameMutation = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) => renameGroup(id, label),
    onSuccess: () => { setRenamingId(null); invalidateGroups() },
    onError: () => notify('error', 'Failed to rename group'),
  })

  const mergeMutation = useMutation({
    mutationFn: ({ targetId, sourceIds }: { targetId: string; sourceIds: string[] }) =>
      mergeGroups(targetId, sourceIds),
    onSuccess: () => {
      setSelected(new Set())
      invalidateGroups()
      notify('success', 'Groups merged')
    },
    onError: () => notify('error', 'Merge failed — groups must be the same kind'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteGroup(id),
    onSuccess: () => {
      setPendingDelete(null)
      if (openGroupId === pendingDelete?.id) setOpenGroupId(null)
      invalidateGroups()
      notify('success', 'Group deleted')
    },
    onError: () => notify('error', 'Failed to delete group'),
  })

  function toggleSelect(g: RecognitionGroup) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(g.id)) next.delete(g.id)
      else next.add(g.id)
      return next
    })
  }

  const selectedGroups = groups.filter((g) => selected.has(g.id))
  const mergeableKinds = new Set(selectedGroups.map((g) => `${g.kind}:${g.class_label ?? ''}`))
  const canMerge = selectedGroups.length >= 2 && mergeableKinds.size === 1

  const indexing = (status?.counts.pending ?? 0) + (status?.counts.processing ?? 0)
  const indexed = status?.counts.done ?? 0

  function startRename(g: RecognitionGroup) {
    setRenamingId(g.id)
    setRenameValue(g.user_label ?? '')
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 shrink-0">
          {openGroup ? (
            <button
              onClick={() => setOpenGroupId(null)}
              className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 bg-transparent border-0 p-0 cursor-pointer"
            >
              <MdArrowBack className="text-base" /> Groups
            </button>
          ) : (
            <MdAutoAwesome className="text-amber-500 text-lg" />
          )}
          <h3 className="text-sm font-semibold text-gray-900 m-0 flex-1 truncate">
            {openGroup ? groupLabel(openGroup) : 'People, pets & objects'}
          </h3>
          <span
            className={`text-[11px] px-2 py-0.5 rounded-full ${
              indexing > 0 ? 'bg-blue-50 text-blue-600' : 'bg-green-50 text-green-600'
            }`}
          >
            {indexing > 0 ? `Indexing ${indexed}/${indexed + indexing}…` : 'Up to date'}
          </span>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 bg-transparent border-0 p-0.5 cursor-pointer"
            aria-label="Close"
          >
            <MdClose className="text-lg" />
          </button>
        </div>

        {/* Storage note */}
        {status && status.storage_bytes > 0 && !openGroup && (
          <div className="px-4 py-1.5 text-[11px] text-gray-400 border-b border-gray-100 shrink-0">
            Recognition data uses {fmtBytes(status.storage_bytes)} of your storage.
          </div>
        )}

        {openGroup ? (
          <GroupFilesGrid group={openGroup} onOpenFile={onOpenFile} />
        ) : (
          <>
            {/* Tab bar + kind filter */}
            <div className="flex items-center gap-1 px-4 py-2 border-b border-gray-200 shrink-0 flex-wrap">
              {(['all', 'labeled'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => { setTab(t); setSelected(new Set()) }}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-colors ${
                    tab === t ? 'bg-blue-50 text-blue-600' : 'text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {t === 'all' ? 'All groups' : 'Labeled'}
                </button>
              ))}
              <div className="w-px h-4 bg-gray-200 mx-1" />
              {(['all', 'face', 'pet', 'object'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => { setKind(k); setSelected(new Set()) }}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-medium cursor-pointer transition-colors ${
                    kind === k ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {k === 'all' ? 'Everything' : k === 'face' ? 'Faces' : k === 'pet' ? 'Pets' : 'Objects'}
                </button>
              ))}
            </div>

            {/* Groups grid */}
            <div className="flex-1 overflow-y-auto p-4">
              {isLoading ? (
                <p className="text-sm text-gray-500">Loading groups…</p>
              ) : groups.length === 0 ? (
                <p className="text-sm text-gray-500">
                  {tab === 'labeled'
                    ? 'No labeled groups yet — label a group to make it searchable.'
                    : indexing > 0
                      ? 'No groups yet — indexing is still running.'
                      : 'No groups found in this collection yet.'}
                </p>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {groups.map((g) => (
                    <div key={g.id} className="relative group">
                      <button
                        onClick={() => setOpenGroupId(g.id)}
                        className="w-full aspect-square rounded-lg overflow-hidden bg-gray-100 border border-gray-200 cursor-pointer p-0"
                      >
                        <GroupCover group={g} />
                      </button>
                      <input
                        type="checkbox"
                        checked={selected.has(g.id)}
                        onChange={() => toggleSelect(g)}
                        className={`absolute top-1.5 left-1.5 cursor-pointer ${
                          selected.size > 0 ? '' : 'opacity-0 group-hover:opacity-100'
                        }`}
                        aria-label={`Select ${groupLabel(g)}`}
                      />
                      {renamingId === g.id ? (
                        <div className="flex items-center gap-1 mt-1">
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') renameMutation.mutate({ id: g.id, label: renameValue.trim() })
                              if (e.key === 'Escape') setRenamingId(null)
                            }}
                            placeholder={g.auto_label}
                            maxLength={80}
                            className="flex-1 min-w-0 text-xs border border-blue-300 rounded px-1 py-0.5 outline-none"
                          />
                          <button
                            onClick={() => renameMutation.mutate({ id: g.id, label: renameValue.trim() })}
                            className="text-green-500 hover:text-green-700 bg-transparent border-0 p-0 cursor-pointer"
                            aria-label="Save label"
                          >
                            <MdCheck className="text-base" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 mt-1">
                          <span className="flex-1 min-w-0 text-xs text-gray-700 truncate" title={groupLabel(g)}>
                            {groupLabel(g)}
                            {g.user_label && g.kind !== 'object' && (
                              <span className="text-gray-400"> · {g.auto_label}</span>
                            )}
                          </span>
                          <span className="text-[10px] text-gray-400 shrink-0">{g.file_count}</span>
                          <button
                            onClick={() => startRename(g)}
                            className="text-gray-400 hover:text-gray-600 bg-transparent border-0 p-0 cursor-pointer opacity-0 group-hover:opacity-100"
                            aria-label={`Rename ${groupLabel(g)}`}
                          >
                            <MdEdit className="text-sm" />
                          </button>
                          {tab === 'labeled' && (
                            <button
                              onClick={() => setPendingDelete(g)}
                              className="text-gray-400 hover:text-red-600 bg-transparent border-0 p-0 cursor-pointer opacity-0 group-hover:opacity-100"
                              aria-label={`Delete ${groupLabel(g)}`}
                            >
                              <MdDelete className="text-sm" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Merge action bar */}
            {selected.size >= 2 && (
              <div className="flex items-center gap-2 px-4 py-2.5 border-t border-gray-200 bg-gray-50 shrink-0">
                <span className="text-xs text-gray-600 flex-1">
                  {selected.size} groups selected{!canMerge && ' — merge needs matching kinds'}
                </span>
                <button
                  onClick={() => setSelected(new Set())}
                  className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg border border-gray-200 cursor-pointer"
                >
                  Clear
                </button>
                <button
                  disabled={!canMerge || mergeMutation.isPending}
                  onClick={() => {
                    const [target, ...sources] = selectedGroups.map((g) => g.id)
                    mergeMutation.mutate({ targetId: target, sourceIds: sources })
                  }}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer disabled:opacity-40"
                >
                  <MdMergeType className="text-sm" />
                  {mergeMutation.isPending ? 'Merging…' : 'Merge'}
                </button>
              </div>
            )}
          </>
        )}

        {/* Delete confirm */}
        {pendingDelete && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center rounded-xl" onClick={() => setPendingDelete(null)}>
            <div className="bg-white rounded-lg shadow-lg p-4 w-72" onClick={(e) => e.stopPropagation()}>
              <p className="text-sm text-gray-800 m-0 mb-3">
                Delete the group “{groupLabel(pendingDelete)}”? Its photos are not deleted.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setPendingDelete(null)}
                  className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg border border-gray-200 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={() => deleteMutation.mutate(pendingDelete.id)}
                  disabled={deleteMutation.isPending}
                  className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium cursor-pointer disabled:opacity-50"
                >
                  {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// GroupFilesGrid pages through a group's files with the familiar media-tile
// look; clicking a tile opens the file preview.
function GroupFilesGrid({ group, onOpenFile }: { group: RecognitionGroup; onOpenFile: (id: string) => void }) {
  const query = useInfiniteQuery({
    queryKey: ['recognition', 'group', group.id, 'files'],
    queryFn: ({ pageParam }) => getGroupFiles(group.id, pageParam || undefined),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.next_token || undefined,
  })
  const files = query.data?.pages.flatMap((p) => p.items) ?? []

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {query.isLoading ? (
        <p className="text-sm text-gray-500">Loading files…</p>
      ) : files.length === 0 ? (
        <p className="text-sm text-gray-500">No files in this group.</p>
      ) : (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {files.map((f) => (
              <button
                key={f.id}
                onClick={() => onOpenFile(f.id)}
                className="aspect-square rounded-lg overflow-hidden bg-gray-100 border border-gray-200 cursor-pointer p-0 relative"
                title={f.name}
              >
                {f.mime_type.startsWith('image/') ? (
                  <img src={previewUrl(f.id)} alt={f.name} loading="lazy" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-300">
                    <MdMovie className="text-3xl" />
                  </div>
                )}
              </button>
            ))}
          </div>
          {query.hasNextPage && (
            <div className="flex justify-center mt-3">
              <button
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
                className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg border border-gray-200 cursor-pointer disabled:opacity-50"
              >
                {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
