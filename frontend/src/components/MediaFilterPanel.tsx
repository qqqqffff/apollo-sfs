import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MdCheckBox, MdCheckBoxOutlineBlank, MdClose, MdFilterAlt } from 'react-icons/md'
import { recognitionGroupsQueryOptions } from '../api/recognition'
import {
  EMPTY_MEDIA_FILTERS,
  UPLOAD_SOURCES,
  countMediaFilters,
} from '../types/api'
import type { MediaFilters, MediaType, RecognitionGroup } from '../types/api'

// Human-readable names for the closed set of files.source values the backend
// writes — mirrors uploadSourceLabel in MediaCollectionView, minus the
// per-device resolution (a filter operates on the source column itself).
export const UPLOAD_SOURCE_LABELS: Record<string, string> = {
  web: 'Web upload',
  device: 'Mobile app',
  google_drive: 'Google Drive backup',
  google_photos: 'Google Photos backup',
  email_backup_gmail: 'Gmail backup',
  email_backup_microsoft: 'Microsoft email backup',
  file_server: 'File Server (WebDAV)',
}

const MEDIA_TYPE_LABELS: Record<MediaType, string> = {
  image: 'Photos',
  video: 'Videos',
  other: 'Other files',
}

// groupLabel prefers the user's own label, falling back to the auto label.
export function groupLabel(g: RecognitionGroup): string {
  return g.user_label || g.auto_label
}

// summarizeMediaFilters renders a filter as a short one-line description —
// used for the chips listing which filters a selection was built from.
export function summarizeMediaFilters(
  f: MediaFilters,
  groupNames: Map<string, string> = new Map(),
): string {
  const parts: string[] = []
  if (f.takenAfter && f.takenBefore) parts.push(`taken ${f.takenAfter} → ${f.takenBefore}`)
  else if (f.takenAfter) parts.push(`taken after ${f.takenAfter}`)
  else if (f.takenBefore) parts.push(`taken before ${f.takenBefore}`)

  if (f.uploadedAfter && f.uploadedBefore) parts.push(`uploaded ${f.uploadedAfter} → ${f.uploadedBefore}`)
  else if (f.uploadedAfter) parts.push(`uploaded after ${f.uploadedAfter}`)
  else if (f.uploadedBefore) parts.push(`uploaded before ${f.uploadedBefore}`)

  if (f.sources.length > 0) {
    parts.push(f.sources.map((s) => UPLOAD_SOURCE_LABELS[s] ?? s).join(', '))
  }
  if (f.mediaTypes.length > 0) {
    parts.push(f.mediaTypes.map((t) => MEDIA_TYPE_LABELS[t]).join(', '))
  }
  if (f.groupIds.length > 0) {
    parts.push(f.groupIds.map((id) => groupNames.get(id) ?? 'Label').join(', '))
  }
  return parts.length > 0 ? parts.join(' · ') : 'All media'
}

interface Props {
  collectionId: string
  // The filter currently applied to the view; the panel opens seeded with it.
  value: MediaFilters
  // In selection mode, applying a filter selects everything matching it
  // instead of narrowing the view (and the panel stays open so several
  // filters can be unioned into one selection).
  selectionMode: boolean
  // Whether the collection has AI recognition on — gates the labels section.
  recognitionEnabled: boolean
  isApplying?: boolean
  // Count of items currently selected, echoed back in selection mode so the
  // effect of each applied filter is visible without closing the panel.
  selectedCount?: number
  onApply: (filters: MediaFilters) => void
  onClose: () => void
}

// MediaFilterPanel is the media grid's filter dialog: date-taken and upload
// date ranges, upload source, media type, and (when AI recognition is on) the
// collection's labeled people/pets/objects. In normal browsing it narrows the
// grid; in selection mode "Select matching" adds every matching item to the
// current selection instead, so several filters can be unioned together.
export function MediaFilterPanel({
  collectionId, value, selectionMode, recognitionEnabled, isApplying,
  selectedCount = 0, onApply, onClose,
}: Props) {
  const [draft, setDraft] = useState<MediaFilters>(value)

  // Labeled groups only — an unlabeled auto-cluster ("Person 4") isn't a
  // useful filter to pick out of a list.
  const { data: groupData } = useQuery({
    ...recognitionGroupsQueryOptions(collectionId, undefined, true),
    enabled: recognitionEnabled,
  })
  const groups = groupData?.groups ?? []

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  function set<K extends keyof MediaFilters>(key: K, v: MediaFilters[K]) {
    setDraft((prev) => ({ ...prev, [key]: v }))
  }

  function toggleIn<T extends string>(list: T[], v: T): T[] {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
  }

  const activeCount = countMediaFilters(draft)

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Filter media"
        className="bg-white rounded-xl shadow-xl w-[28rem] max-w-[95vw] max-h-[88vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900 m-0 flex items-center gap-1.5">
            <MdFilterAlt className="text-base text-blue-500" />
            {selectionMode ? 'Select by filter' : 'Filter media'}
          </h3>
          <button
            onClick={onClose}
            aria-label="Close filters"
            className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0.5"
          >
            <MdClose className="text-lg" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5">
          {selectionMode && (
            <p className="text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 m-0">
              Selection is active — “Select matching” adds every item matching these
              criteria to your selection. Apply several filters in a row to build a
              selection out of more than one.
            </p>
          )}

          <Section title="Date taken">
            <DateRange
              name="Date taken"
              afterValue={draft.takenAfter}
              beforeValue={draft.takenBefore}
              onAfter={(v) => set('takenAfter', v)}
              onBefore={(v) => set('takenBefore', v)}
            />
            <p className="text-[11px] text-gray-400 m-0 mt-1">
              Items with no capture date fall back to their upload date.
            </p>
          </Section>

          <Section title="Upload date">
            <DateRange
              name="Upload date"
              afterValue={draft.uploadedAfter}
              beforeValue={draft.uploadedBefore}
              onAfter={(v) => set('uploadedAfter', v)}
              onBefore={(v) => set('uploadedBefore', v)}
            />
          </Section>

          <Section title="Upload source">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {UPLOAD_SOURCES.map((s) => (
                <CheckRow
                  key={s}
                  checked={draft.sources.includes(s)}
                  label={UPLOAD_SOURCE_LABELS[s]}
                  onToggle={() => set('sources', toggleIn(draft.sources, s as string))}
                />
              ))}
            </div>
          </Section>

          <Section title="Media type">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {(Object.keys(MEDIA_TYPE_LABELS) as MediaType[]).map((t) => (
                <CheckRow
                  key={t}
                  checked={draft.mediaTypes.includes(t)}
                  label={MEDIA_TYPE_LABELS[t]}
                  onToggle={() => set('mediaTypes', toggleIn(draft.mediaTypes, t))}
                />
              ))}
            </div>
          </Section>

          {recognitionEnabled && (
            <Section title="Labeled people, pets &amp; objects">
              {groups.length === 0 ? (
                <p className="text-xs text-gray-400 m-0">
                  No labeled groups yet — name a person, pet, or object in “People &amp; pets”
                  and it will show up here.
                </p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 max-h-44 overflow-y-auto">
                  {groups.map((g) => (
                    <CheckRow
                      key={g.id}
                      checked={draft.groupIds.includes(g.id)}
                      label={`${groupLabel(g)} (${g.file_count})`}
                      onToggle={() => set('groupIds', toggleIn(draft.groupIds, g.id))}
                    />
                  ))}
                </div>
              )}
            </Section>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-gray-100">
          <button
            onClick={() => setDraft(EMPTY_MEDIA_FILTERS)}
            disabled={activeCount === 0}
            className="text-xs text-gray-500 hover:text-gray-700 cursor-pointer bg-transparent border-0 p-0 disabled:opacity-40 disabled:cursor-default"
          >
            Clear all
          </button>
          <div className="flex items-center gap-2">
            {selectionMode && selectedCount > 0 && (
              <span className="text-xs text-gray-500">{selectedCount} selected</span>
            )}
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 cursor-pointer transition-colors"
            >
              {selectionMode ? 'Done' : 'Cancel'}
            </button>
            <button
              onClick={() => onApply(draft)}
              disabled={isApplying || (selectionMode && activeCount === 0)}
              className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default"
            >
              {isApplying
                ? 'Working…'
                : selectionMode
                  ? 'Select matching'
                  : activeCount > 0 ? `Apply ${activeCount} filter${activeCount !== 1 ? 's' : ''}` : 'Apply'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider m-0 mb-1.5">{title}</h4>
      {children}
    </section>
  )
}

function DateRange({
  name, afterValue, beforeValue, onAfter, onBefore,
}: {
  // Names the range for assistive tech, since the panel has two of them
  // ("Date taken after" vs "Upload date after").
  name: string
  afterValue: string
  beforeValue: string
  onAfter: (v: string) => void
  onBefore: (v: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-xs text-gray-600">
        After
        <input
          type="date"
          aria-label={`${name} after`}
          value={afterValue}
          onChange={(e) => onAfter(e.target.value)}
          className="border border-gray-200 rounded-lg px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </label>
      <label className="flex items-center gap-1.5 text-xs text-gray-600">
        Before
        <input
          type="date"
          aria-label={`${name} before`}
          value={beforeValue}
          onChange={(e) => onBefore(e.target.value)}
          className="border border-gray-200 rounded-lg px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </label>
    </div>
  )
}

function CheckRow({ checked, label, onToggle }: { checked: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      role="checkbox"
      aria-checked={checked}
      className="flex items-center gap-1.5 text-left text-xs text-gray-700 cursor-pointer bg-transparent border-0 p-0.5 hover:text-gray-900"
    >
      {checked
        ? <MdCheckBox className="text-base text-blue-500 shrink-0" />
        : <MdCheckBoxOutlineBlank className="text-base text-gray-300 shrink-0" />}
      <span className="truncate">{label}</span>
    </button>
  )
}
