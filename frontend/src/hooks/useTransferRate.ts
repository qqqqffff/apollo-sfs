import { useRef } from 'react'

// Sliding-window bytes/sec estimator shared by the Google/email backup flows
// (foreground modals and their background toolbar cards) — same idea as the
// sample windows in useFileUpload/useDeleteJob, just driven by discrete
// progress events instead of a flush timer, since neither backup flow polls
// on an interval.
const RATE_WINDOW_MS = 4000

interface TransferRate {
  record(bytes: number): void
  rate(): number
  reset(): void
}

// Returns a stable object (computed once, via a lazily-initialized ref) so
// callers that memoize with useCallback can safely list it as a dependency
// without that callback being recreated on every render.
export function useTransferRate(): TransferRate {
  const samples = useRef<{ t: number; bytes: number }[]>([])
  const api = useRef<TransferRate | null>(null)

  if (!api.current) {
    api.current = {
      record(bytes: number) {
        const now = Date.now()
        samples.current.push({ t: now, bytes })
        const cutoff = now - RATE_WINDOW_MS
        while (samples.current.length > 2 && samples.current[0].t < cutoff) {
          samples.current.shift()
        }
      },
      rate(): number {
        const s = samples.current
        if (s.length < 2) return 0
        const dt = (s[s.length - 1].t - s[0].t) / 1000
        if (dt < 0.05) return 0
        return Math.max(0, (s[s.length - 1].bytes - s[0].bytes) / dt)
      },
      reset() {
        samples.current = []
      },
    }
  }

  return api.current
}
