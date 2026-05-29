import { renderHook, act } from '@testing-library/react'
import { useMetricsStream } from '../../hooks/useMetricsStream'

// ── WebSocket mock ────────────────────────────────────────────────────────────

class MockWebSocket {
  static last: MockWebSocket | null = null
  url: string
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = jest.fn(() => { this.onclose?.() })

  constructor(url: string) {
    this.url = url
    MockWebSocket.last = this
  }

  _open()                 { this.onopen?.() }
  _message(data: string)  { this.onmessage?.({ data }) }
  _close()                { this.onclose?.() }
  _error()                { this.onerror?.() }
}

beforeEach(() => {
  jest.useFakeTimers()
  MockWebSocket.last = null
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket
})

afterEach(() => {
  jest.useRealTimers()
})

const SNAP = { cpu_percent: 10, memory_used_bytes: 100, sampled_at: '2024-01-01T00:00:00Z' }

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useMetricsStream', () => {
  it('starts with empty snapshots and connected=false', () => {
    const { result } = renderHook(() => useMetricsStream())
    expect(result.current.snapshots).toEqual([])
    expect(result.current.connected).toBe(false)
  })

  it('sets connected=true when the WebSocket opens', () => {
    const { result } = renderHook(() => useMetricsStream())
    act(() => MockWebSocket.last!._open())
    expect(result.current.connected).toBe(true)
  })

  it('connects to the correct metrics stream URL', () => {
    renderHook(() => useMetricsStream())
    expect(MockWebSocket.last!.url).toMatch(/\/api\/v1\/admin\/system\/metrics\/stream$/)
  })

  it('appends a snapshot when a message arrives', () => {
    const { result } = renderHook(() => useMetricsStream())
    act(() => {
      MockWebSocket.last!._open()
      MockWebSocket.last!._message(JSON.stringify(SNAP))
    })
    expect(result.current.snapshots).toHaveLength(1)
    expect(result.current.snapshots[0].cpu_percent).toBe(10)
  })

  it('accumulates multiple snapshots', () => {
    const { result } = renderHook(() => useMetricsStream())
    act(() => {
      MockWebSocket.last!._open()
      MockWebSocket.last!._message(JSON.stringify({ ...SNAP, cpu_percent: 1 }))
      MockWebSocket.last!._message(JSON.stringify({ ...SNAP, cpu_percent: 2 }))
      MockWebSocket.last!._message(JSON.stringify({ ...SNAP, cpu_percent: 3 }))
    })
    expect(result.current.snapshots).toHaveLength(3)
  })

  it('caps the snapshot buffer at 720 entries', () => {
    const { result } = renderHook(() => useMetricsStream())
    act(() => {
      MockWebSocket.last!._open()
      for (let i = 0; i < 730; i++) {
        MockWebSocket.last!._message(JSON.stringify({ ...SNAP, cpu_percent: i }))
      }
    })
    expect(result.current.snapshots).toHaveLength(720)
    // The oldest entries were trimmed — the last value should be 729
    expect(result.current.snapshots[719].cpu_percent).toBe(729)
  })

  it('sets connected=false when the socket closes', () => {
    const { result } = renderHook(() => useMetricsStream())
    act(() => MockWebSocket.last!._open())
    expect(result.current.connected).toBe(true)
    act(() => {
      jest.spyOn(global, 'setTimeout')
      MockWebSocket.last!._close()
    })
    expect(result.current.connected).toBe(false)
  })

  it('reconnects after a delay when the socket closes', () => {
    renderHook(() => useMetricsStream())
    const firstWs = MockWebSocket.last!
    act(() => firstWs._open())

    act(() => {
      firstWs._close()
      jest.runAllTimers()
    })

    // A new WebSocket should have been created
    expect(MockWebSocket.last).not.toBe(firstWs)
  })

  it('ignores malformed message frames', () => {
    const { result } = renderHook(() => useMetricsStream())
    act(() => {
      MockWebSocket.last!._open()
      MockWebSocket.last!._message('not-valid-json{{')
    })
    expect(result.current.snapshots).toHaveLength(0)
  })

  it('closes the socket and stops reconnecting on unmount', () => {
    const { unmount } = renderHook(() => useMetricsStream())
    const ws = MockWebSocket.last!
    act(() => ws._open())
    unmount()
    expect(ws.close).toHaveBeenCalled()
  })

  it('does not reconnect after unmount', () => {
    const { unmount } = renderHook(() => useMetricsStream())
    const firstWs = MockWebSocket.last!
    act(() => firstWs._open())
    unmount()
    MockWebSocket.last = null

    act(() => jest.runAllTimers())
    // No new WebSocket should be created after unmount
    expect(MockWebSocket.last).toBeNull()
  })

  it('closes the socket on error', () => {
    renderHook(() => useMetricsStream())
    const ws = MockWebSocket.last!
    act(() => ws._error())
    expect(ws.close).toHaveBeenCalled()
  })
})
