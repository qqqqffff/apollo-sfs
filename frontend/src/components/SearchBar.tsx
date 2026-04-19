import { useEffect, useRef, useState } from 'react'

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}

export function SearchBar({ value, onChange, placeholder = 'Search files and folders…' }: Props) {
  const [local, setLocal] = useState(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync external resets (e.g. navigating to a new folder clears search)
  useEffect(() => {
    setLocal(value)
  }, [value])

  function handleChange(v: string) {
    setLocal(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => onChange(v), 300)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 12 }}>
      <input
        type="search"
        value={local}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        style={{
          flex: 1,
          padding: '6px 10px',
          borderRadius: 6,
          border: '1px solid #ddd',
          fontSize: 13,
          outline: 'none',
          minWidth: 0,
        }}
      />
      {local && (
        <button
          onClick={() => handleChange('')}
          aria-label="Clear search"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 16,
            color: '#888',
            padding: '0 4px',
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      )}
    </div>
  )
}
