import { createContext, useCallback, useContext } from 'react'
import type React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { login as apiLogin, logout as apiLogout } from './api/auth'
import { getMe, meQueryOptions } from './api/me'
import type { User } from './types/api'
import { ApiError } from './api/client'

type LoginReturnType = 'fail' | 'admin' | 'client' | 'nextStep' | 'banned' | 'suspended'

export interface AuthContext {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
  validateAuth: () => Promise<boolean | 'banned' | 'suspended'>
  login: (username: string, password: string) => Promise<LoginReturnType>
  confirmLogin: (username: string, password: string) => Promise<LoginReturnType>
  logout: () => Promise<'success' | 'fail'>
  admin: boolean
  updateProfile: (updatedUser: User) => Promise<'success' | 'fail'>
}

function storeRestriction(body: Record<string, unknown>) {
  try {
    sessionStorage.setItem('apollo_restriction', JSON.stringify(body))
  } catch { /* ignore */ }
}

function isRestriction(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    err.status === 403 &&
    (err.body.error === 'banned' || err.body.error === 'suspended')
  )
}

const AuthContext = createContext<AuthContext | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()
  const { data: user, isLoading } = useQuery(meQueryOptions)

  const validateAuth = useCallback(async (): Promise<boolean | 'banned' | 'suspended'> => {
    try {
      const me = await queryClient.fetchQuery(meQueryOptions)
      return !!me
    } catch (err) {
      if (isRestriction(err)) {
        storeRestriction(err.body)
        return err.body.error as 'banned' | 'suspended'
      }
      return false
    }
  }, [queryClient])

  const login = useCallback(
    async (username: string, password: string): Promise<LoginReturnType> => {
      try {
        await apiLogin(username, password)
        const me = await queryClient.fetchQuery({
          ...meQueryOptions,
          staleTime: 0,
        })
        await queryClient.invalidateQueries({ queryKey: ['me'] })
        return me.is_admin ? 'admin' : 'client'
      } catch (err) {
        if (isRestriction(err)) {
          storeRestriction(err.body)
          return err.body.error as 'banned' | 'suspended'
        }
        return 'fail'
      }
    },
    [queryClient],
  )

  // Alias for a potential two-step login flow; behaves identically until backend supports it.
  const confirmLogin = useCallback(
    (username: string, password: string) => login(username, password),
    [login],
  )

  const logout = useCallback(async (): Promise<'success' | 'fail'> => {
    try {
      await apiLogout()
      queryClient.clear()
      return 'success'
    } catch {
      return 'fail'
    }
  }, [queryClient])

  const updateProfile = useCallback(
    async (updatedUser: User): Promise<'success' | 'fail'> => {
      queryClient.setQueryData(meQueryOptions.queryKey, updatedUser)
      try {
        await getMe()
        return 'success'
      } catch {
        return 'fail'
      }
    },
    [queryClient],
  )

  return (
    <AuthContext.Provider
      value={{
        user: user ?? null,
        isLoading,
        isAuthenticated: !!user,
        validateAuth,
        login,
        confirmLogin,
        logout,
        admin: user?.is_admin ?? false,
        updateProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)

  if (!context) throw new Error('useAuth must be used within an AuthProvider')

  return context
}
