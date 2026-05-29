import { useEffect, useRef, useState } from 'react'
import { MdClose, MdSearch } from 'react-icons/md'

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}

export function SearchBar({ value, onChange, placeholder = 'Search files and folders…' }: Props) {
  const [local, setLocal] = useState(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setLocal(value)
  }, [value])

  function handleChange(v: string) {
    setLocal(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => onChange(v), 300)
  }

  return (
    <div className="relative flex items-center mb-3">
      <MdSearch className="absolute left-3 text-gray-400 text-lg pointer-events-none" />
      <input
        type="search"
        value={local}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-9 pr-8 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
      {local && (
        <button
          onClick={() => handleChange('')}
          aria-label="Clear search"
          className="absolute right-2 text-gray-400 hover:text-gray-600 cursor-pointer"
        >
          <MdClose className="text-base" />
        </button>
      )}
    </div>
  )
}
