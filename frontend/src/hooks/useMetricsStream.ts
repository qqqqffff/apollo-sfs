import { useEffect, useRef, useState } from 'react'
import type { MetricsFrame } from '../api/admin'

// 720 frames ≈ 1 hour at 5-second intervals
const MAX_SNAPSHOTS = 720

export function useMetricsStream(paused = false) {
  const [frames, setFrames] = useState<MetricsFrame[]>([])
  const [connected, setConnected] = useState(false)
  const reconnectDelay = useRef(1_000)
  const cancelledRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (paused) {
      cancelledRef.current = true
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      setConnected(false)
      return
    }

    cancelledRef.current = false
    reconnectDelay.current = 1_000

    function connect() {
      if (cancelledRef.current) return

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(
        `${protocol}//${location.host}/api/v1/admin/system/metrics/stream`,
      )
      wsRef.current = ws

      ws.onopen = () => {
        if (!cancelledRef.current) {
          setConnected(true)
          reconnectDelay.current = 1_000
        }
      }

      ws.onmessage = (e: MessageEvent<string>) => {
        if (cancelledRef.current) return
        try {
          const frame = JSON.parse(e.data) as MetricsFrame
          if (!frame || !frame.cluster) return
          setFrames(prev => {
            const next = [...prev, frame]
            return next.length > MAX_SNAPSHOTS
              ? next.slice(next.length - MAX_SNAPSHOTS)
              : next
          })
        } catch {
          // ignore malformed frames
        }
      }

      ws.onclose = () => {
        if (!cancelledRef.current) {
          setConnected(false)
          const delay = reconnectDelay.current
          reconnectDelay.current = Math.min(delay * 2, 30_000)
          setTimeout(connect, delay)
        }
      }

      ws.onerror = () => ws.close()
    }

    connect()

    return () => {
      cancelledRef.current = true
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [paused])

  return { frames, connected }
}
