import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { AuthContext, AuthProvider, useAuth } from '../auth'

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
    <AuthProvider>
      <RootLayout />
    </AuthProvider>
  )
}

function RootLayout() {
  const { isAuthenticated } = useAuth()
  return (
    <>
      {!isAuthenticated && <PublicHeader />}
      <Outlet />
    </>
  )
}

function PublicHeader() {
  return (
    <header className="bg-white border-b border-gray-200 px-6 h-14 flex items-center justify-between">
      <Link to="/" className="font-semibold text-gray-900 text-sm tracking-tight no-underline">
        Apollo SFS
      </Link>
      <Link
        to="/login"
        className="px-4 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg no-underline transition-colors"
      >
        Sign in
      </Link>
    </header>
  )
}
