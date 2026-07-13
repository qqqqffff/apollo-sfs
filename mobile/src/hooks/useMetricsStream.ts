import { useEffect, useRef, useState } from 'react';
import { getStoredTokens } from '../api/client';
import { API_BASE_URL } from '../config';
import type { MetricsFrame } from '../api/admin';

// 720 frames ≈ 1 hour at 5-second intervals — same window the web keeps.
const MAX_SNAPSHOTS = 720;

// Streams admin metrics frames over the same WebSocket the web dashboard uses
// (GET /api/v1/admin/system/metrics/stream), authenticating with the stored
// Bearer token via the handshake headers (React Native supports these).
export function useMetricsStream(paused = false) {
  const [frames, setFrames] = useState<MetricsFrame[]>([]);
  const [connected, setConnected] = useState(false);
  const reconnectDelay = useRef(1_000);
  const cancelledRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (paused) {
      cancelledRef.current = true;
      wsRef.current?.close();
      wsRef.current = null;
      setConnected(false);
      return;
    }

    cancelledRef.current = false;
    reconnectDelay.current = 1_000;

    async function connect() {
      if (cancelledRef.current) return;

      const { access } = await getStoredTokens();
      if (cancelledRef.current) return;

      const wsUrl = `${API_BASE_URL.replace(/^http/, 'ws')}/api/v1/admin/system/metrics/stream`;
      const ws = new WebSocket(wsUrl, null, {
        headers: access ? { Authorization: `Bearer ${access}` } : {},
      });
      wsRef.current = ws;

      ws.onopen = () => {
        if (!cancelledRef.current) {
          setConnected(true);
          reconnectDelay.current = 1_000;
        }
      };

      ws.onmessage = (e) => {
        if (cancelledRef.current) return;
        try {
          const frame = JSON.parse(String(e.data)) as MetricsFrame;
          if (!frame || !frame.cluster) return;
          setFrames((prev) => {
            const next = [...prev, frame];
            return next.length > MAX_SNAPSHOTS ? next.slice(next.length - MAX_SNAPSHOTS) : next;
          });
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        if (!cancelledRef.current) {
          setConnected(false);
          const delay = reconnectDelay.current;
          reconnectDelay.current = Math.min(delay * 2, 30_000);
          timerRef.current = setTimeout(connect, delay);
        }
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [paused]);

  return { frames, connected };
}
