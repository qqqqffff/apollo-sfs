import { createContext, useContext, useState, useCallback } from 'react'
import type { User } from '../types/api'

const STORAGE_KEY = 'apollo_impersonated_user'

interface ImpersonationContextValue {
  impersonatedUser: User | null
  impersonate: (user: User) => void
  clearImpersonation: () => void
}

const ImpersonationContext = createContext<ImpersonationContextValue | null>(null)

export function ImpersonationProvider({ children }: { children: React.ReactNode }) {
  const [impersonatedUser, setImpersonatedUser] = useState<User | null>(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY)
      return stored ? (JSON.parse(stored) as User) : null
    } catch {
      return null
    }
  })

  const impersonate = useCallback((user: User) => {
    setImpersonatedUser(user)
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(user))
  }, [])

  const clearImpersonation = useCallback(() => {
    setImpersonatedUser(null)
    sessionStorage.removeItem(STORAGE_KEY)
  }, [])

  return (
    <ImpersonationContext.Provider value={{ impersonatedUser, impersonate, clearImpersonation }}>
      {children}
    </ImpersonationContext.Provider>
  )
}

export function useImpersonation() {
  const ctx = useContext(ImpersonationContext)
  if (!ctx) throw new Error('useImpersonation must be used within ImpersonationProvider')
  return ctx
}
