import { createRootRouteWithContext, Link, Outlet, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { AuthContext, AuthProvider, useAuth } from '../auth'
import { AppIcon } from '../components/AppIcon'
import { clearSkipDeleteCookie } from '../components/DeleteConfirmModal'
import { NotificationProvider, useNotification } from '../context/NotificationContext'
import { ImpersonationProvider } from '../context/ImpersonationContext'
import { NotificationBanner } from '../components/NotificationBanner'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient; auth: AuthContext }>()({
  component: Root,
  notFoundComponent: () => (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-3">
      <p className="text-lg font-semibold text-gray-900">Page not found</p>
      <Link to="/" className="text-sm text-blue-600 hover:text-blue-800 transition-colors">
        Return home
      </Link>
    </div>
  ),
})

function Root() {
  return (
    <NotificationProvider>
      <AuthProvider>
        <ImpersonationProvider>
          <RootLayout />
        </ImpersonationProvider>
      </AuthProvider>
    </NotificationProvider>
  )
}

function RootLayout() {
  const { isAuthenticated } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { notify } = useNotification()

  useEffect(() => {
    function handleSessionExpired() {
      if (window.location.pathname === '/login') return
      clearSkipDeleteCookie()
      queryClient.clear()
      notify('error', 'Your session has expired. Please sign in again.')
      navigate({ to: '/login' })
    }
    window.addEventListener('apollo:session-expired', handleSessionExpired)
    return () => window.removeEventListener('apollo:session-expired', handleSessionExpired)
  }, [navigate, notify, queryClient])

  return (
    <>
      {!isAuthenticated && <PublicHeader />}
      <Outlet />
      <NotificationBanner />
    </>
  )
}

function PublicHeader() {
  return (
    <header className="bg-white border-b border-gray-200 px-6 h-14 flex items-center justify-between">
      <Link to="/" className="flex items-center gap-2 no-underline">
        <AppIcon size={26} />
        <span className="font-semibold text-gray-900 text-sm tracking-tight">Apollo SFS</span>
      </Link>
      <div className="flex items-center gap-4">
        <Link
          to="/about"
          className="text-sm text-gray-500 hover:text-gray-900 no-underline transition-colors"
        >
          About
        </Link>
        <Link
          to="/interest"
          className="text-sm text-gray-500 hover:text-gray-900 no-underline transition-colors"
        >
          Request access
        </Link>
        <Link
          to="/login"
          className="px-4 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg no-underline transition-colors"
        >
          Sign in
        </Link>
      </div>
    </header>
  )
}
