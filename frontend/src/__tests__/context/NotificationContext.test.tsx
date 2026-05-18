import React from 'react'
import { renderHook, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import { NotificationProvider, useNotification } from '../../context/NotificationContext'

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <NotificationProvider>{children}</NotificationProvider>
)

describe('useNotification', () => {
  test('throws when used outside NotificationProvider', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useNotification())).toThrow(
      'useNotification must be used within NotificationProvider',
    )
    spy.mockRestore()
  })

  test('starts with an empty notifications list', () => {
    const { result } = renderHook(() => useNotification(), { wrapper })
    expect(result.current.notifications).toHaveLength(0)
  })

  test('notify adds a notification with the correct type and message', () => {
    const { result } = renderHook(() => useNotification(), { wrapper })
    act(() => result.current.notify('success', 'Hello'))
    expect(result.current.notifications).toHaveLength(1)
    expect(result.current.notifications[0]).toMatchObject({ type: 'success', message: 'Hello' })
  })

  test('each notification gets a unique id', () => {
    const { result } = renderHook(() => useNotification(), { wrapper })
    act(() => {
      result.current.notify('success', 'A')
      result.current.notify('error', 'B')
    })
    const ids = result.current.notifications.map((n) => n.id)
    expect(new Set(ids).size).toBe(2)
  })

  test('dismiss removes the correct notification', () => {
    const { result } = renderHook(() => useNotification(), { wrapper })
    act(() => {
      result.current.notify('success', 'First')
      result.current.notify('error', 'Second')
    })
    const idToRemove = result.current.notifications.find((n) => n.message === 'First')!.id
    act(() => result.current.dismiss(idToRemove))
    expect(result.current.notifications).toHaveLength(1)
    expect(result.current.notifications[0].message).toBe('Second')
  })

  test('notifications auto-dismiss after 5 seconds', () => {
    jest.useFakeTimers()
    const { result } = renderHook(() => useNotification(), { wrapper })
    act(() => result.current.notify('success', 'Auto'))
    expect(result.current.notifications).toHaveLength(1)
    act(() => jest.advanceTimersByTime(5000))
    expect(result.current.notifications).toHaveLength(0)
    jest.useRealTimers()
  })

  test('caps at 4 visible notifications (MAX_VISIBLE)', () => {
    const { result } = renderHook(() => useNotification(), { wrapper })
    act(() => {
      for (let i = 0; i < 6; i++) result.current.notify('success', `Message ${i}`)
    })
    expect(result.current.notifications).toHaveLength(4)
  })

  test('new notifications are prepended so the newest appears first', () => {
    const { result } = renderHook(() => useNotification(), { wrapper })
    act(() => {
      result.current.notify('success', 'First')
      result.current.notify('success', 'Second')
    })
    expect(result.current.notifications[0].message).toBe('Second')
  })
})
