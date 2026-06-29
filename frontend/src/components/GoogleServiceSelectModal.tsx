import { useEffect, useState } from 'react'
import { MdCloud, MdPhotoLibrary } from 'react-icons/md'
import { HiOutlineServer } from 'react-icons/hi'

export interface GoogleServiceSelection {
  photos: boolean
  drive: boolean
}

interface Props {
  onCancel: () => void
  onContinue: (selection: GoogleServiceSelection) => void
}

const ROWS = [
  {
    key: 'photos' as const,
    label: 'Google Photos',
    desc: 'Pick photos and videos to back up',
    Icon: MdPhotoLibrary,
    iconClass: 'text-red-400',
  },
  {
    key: 'drive' as const,
    label: 'Google Drive',
    desc: 'Back up files from your Drive',
    Icon: HiOutlineServer,
    iconClass: 'text-blue-500',
  },
]

export function GoogleServiceSelectModal({ onCancel, onContinue }: Props) {
  const [photos, setPhotos] = useState(true)
  const [drive, setDrive]   = useState(true)
  const canContinue = photos || drive

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const state = { photos, drive }
  const toggle = { photos: () => setPhotos((v) => !v), drive: () => setDrive((v) => !v) }

  return (
    <div
      onClick={onCancel}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-96 max-w-[92vw] p-6 flex flex-col gap-4"
      >
        <div className="flex items-center gap-2">
          <MdCloud className="text-blue-500 text-xl" />
          <h3 className="text-base font-semibold text-gray-900 m-0">What do you want to back up?</h3>
        </div>

        <div className="flex flex-col divide-y divide-gray-100">
          {ROWS.map((row) => (
            <button
              key={row.key}
              onClick={toggle[row.key]}
              className="flex items-center gap-3 py-3 text-left hover:bg-gray-50 rounded-lg px-1 transition-colors cursor-pointer"
            >
              <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                <row.Icon className={`text-lg ${row.iconClass}`} />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-gray-900">{row.label}</div>
                <div className="text-xs text-gray-500 mt-0.5">{row.desc}</div>
              </div>
              <div
                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                  state[row.key]
                    ? 'bg-blue-600 border-blue-600'
                    : 'border-gray-300'
                }`}
              >
                {state[row.key] && (
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 12 12">
                    <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
            </button>
          ))}
        </div>

        {!canContinue && (
          <p className="text-xs text-red-500 -mt-1">Select at least one service to continue.</p>
        )}

        <div className="flex gap-2 pt-1">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => canContinue && onContinue({ photos, drive })}
            disabled={!canContinue}
            className="flex-1 px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-40 cursor-pointer transition-colors"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}
