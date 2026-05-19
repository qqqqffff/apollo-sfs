import React from 'react'
import { renderHook, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ImpersonationProvider, useImpersonation } from '../../context/ImpersonationContext'

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ImpersonationProvider>{children}</ImpersonationProvider>
)

const ALICE = { username: 'alice', email: 'alice@example.com', is_admin: false, storage_used_bytes: 0, storage_quota_bytes: 0, created_at: '', last_seen_at: null }

describe('useImpersonation', () => {
  beforeEach(() => sessionStorage.clear())

  test('throws when used outside ImpersonationProvider', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useImpersonation())).toThrow(
      'useImpersonation must be used within ImpersonationProvider',
    )
    spy.mockRestore()
  })

  test('starts with impersonatedUser as null', () => {
    const { result } = renderHook(() => useImpersonation(), { wrapper })
    expect(result.current.impersonatedUser).toBeNull()
  })

  test('impersonate sets the impersonated user', () => {
    const { result } = renderHook(() => useImpersonation(), { wrapper })
    act(() => { result.current.impersonate(ALICE) })
    expect(result.current.impersonatedUser).toEqual(ALICE)
  })

  test('clearImpersonation resets to null', () => {
    const { result } = renderHook(() => useImpersonation(), { wrapper })
    act(() => { result.current.impersonate(ALICE) })
    act(() => { result.current.clearImpersonation() })
    expect(result.current.impersonatedUser).toBeNull()
  })

  test('impersonate persists user to sessionStorage', () => {
    const { result } = renderHook(() => useImpersonation(), { wrapper })
    act(() => { result.current.impersonate(ALICE) })
    const stored = JSON.parse(sessionStorage.getItem('apollo_impersonated_user') ?? 'null')
    expect(stored).toEqual(ALICE)
  })

  test('clearImpersonation removes user from sessionStorage', () => {
    const { result } = renderHook(() => useImpersonation(), { wrapper })
    act(() => { result.current.impersonate(ALICE) })
    act(() => { result.current.clearImpersonation() })
    expect(sessionStorage.getItem('apollo_impersonated_user')).toBeNull()
  })

  test('initialises from sessionStorage on mount', () => {
    sessionStorage.setItem('apollo_impersonated_user', JSON.stringify(ALICE))
    const { result } = renderHook(() => useImpersonation(), { wrapper })
    expect(result.current.impersonatedUser).toEqual(ALICE)
  })
})
