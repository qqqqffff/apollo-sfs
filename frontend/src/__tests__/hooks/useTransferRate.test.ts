import { renderHook, act } from '@testing-library/react'
import { useTransferRate } from '../../hooks/useTransferRate'

describe('useTransferRate', () => {
  afterEach(() => jest.useRealTimers())

  test('returns 0 with fewer than two samples', () => {
    const { result } = renderHook(() => useTransferRate())
    expect(result.current.rate()).toBe(0)
    act(() => result.current.record(100))
    expect(result.current.rate()).toBe(0)
  })

  test('computes bytes/sec from the oldest and newest sample in the window', () => {
    jest.useFakeTimers().setSystemTime(0)
    const { result } = renderHook(() => useTransferRate())
    act(() => result.current.record(0))
    jest.setSystemTime(2000)
    act(() => result.current.record(2000))
    expect(result.current.rate()).toBeCloseTo(1000)
  })

  test('reset clears accumulated samples', () => {
    jest.useFakeTimers().setSystemTime(0)
    const { result } = renderHook(() => useTransferRate())
    act(() => result.current.record(0))
    jest.setSystemTime(1000)
    act(() => result.current.record(1000))
    expect(result.current.rate()).toBeGreaterThan(0)

    act(() => result.current.reset())
    expect(result.current.rate()).toBe(0)
  })

  test('returns a stable object identity across re-renders, safe for a useCallback dependency array', () => {
    const { result, rerender } = renderHook(() => useTransferRate())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
