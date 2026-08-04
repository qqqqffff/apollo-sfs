import { useEffect, useState, type ReactEventHandler } from 'react'
import { MdBrokenImage } from 'react-icons/md'

const MAX_RETRIES = 4
const BASE_DELAY_MS = 600

// Same 429 retry-with-backoff philosophy as the JSON API client
// (api/client.ts) — a rate-limited request was refused before the handler
// ran, so it's always safe to repeat. A bare <img src> bypasses that client
// entirely and has no retry of its own, which is why a burst of thumbnails
// (e.g. the virtualized media grid mounting several screens at once) can
// leave some tiles permanently broken even though a lone re-request — like
// opening the same file full-screen — succeeds once the burst has passed.
export function RetryImg({ src, alt, className, loading, onLoad }: {
  src: string
  alt: string
  className?: string
  loading?: 'lazy' | 'eager'
  onLoad?: ReactEventHandler<HTMLImageElement>
}) {
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setAttempt(0)
    setFailed(false)
  }, [src])

  function handleError() {
    if (attempt >= MAX_RETRIES) { setFailed(true); return }
    const delay = BASE_DELAY_MS * 2 ** attempt + Math.random() * 250
    setTimeout(() => setAttempt((a) => a + 1), delay)
  }

  if (failed) {
    return (
      <div className={`flex items-center justify-center bg-gray-100 text-gray-300 ${className ?? ''}`}>
        <MdBrokenImage className="text-2xl" />
      </div>
    )
  }

  // Cache-bust every retry so the browser issues a genuinely fresh request
  // rather than reusing the one that just failed.
  const attemptSrc = attempt === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}retry=${attempt}`

  return (
    <img
      src={attemptSrc}
      alt={alt}
      loading={loading}
      className={className}
      onLoad={onLoad}
      onError={handleError}
    />
  )
}
