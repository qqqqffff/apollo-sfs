import { useEffect, useState } from 'react'
import { MdClose } from 'react-icons/md'

interface Props {
  message: string
  onCancel: () => void
}

// Blocking modal shown while a Google backup is being prepared — most importantly
// while the Google Photos picker tab is open and we poll for the user's selection.
// The trailing "..." animates by cycling 0–3 dots; a fixed-width slot keeps the
// text from shifting as dots are added and removed.
export function GooglePhotosLoadingModal({ message, onCancel }: Props) {
  const [dots, setDots] = useState('')

  useEffect(() => {
    const id = setInterval(() => setDots((d) => (d.length >= 3 ? '' : `${d}.`)), 400)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div
        className="bg-white rounded-xl shadow-2xl flex flex-col items-center text-center p-6 gap-4"
        style={{ width: 360, maxWidth: '92vw' }}
      >
        <div className="w-10 h-10 border-[3px] border-blue-500 border-t-transparent rounded-full animate-spin" />

        <div className="text-sm font-semibold text-gray-900">
          {message}
          <span className="inline-block w-5 text-left">{dots}</span>
        </div>

        <p className="text-xs text-gray-500 leading-relaxed">
          Finish choosing in the Google tab, then come back here — your selection loads automatically.
        </p>

        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg cursor-pointer transition-colors"
        >
          <MdClose className="text-base" /> Cancel
        </button>
      </div>
    </div>
  )
}
