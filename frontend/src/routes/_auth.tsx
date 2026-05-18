import { createFileRoute, Link, Outlet, redirect, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useEffect, useRef } from 'react'
import { MdMenu, MdClose } from 'react-icons/md'
import { AppIcon } from '../components/AppIcon'
import { meQueryOptions } from '../api/me'
import { logout } from '../api/auth'
import { clearSkipDeleteCookie } from '../components/DeleteConfirmModal'

export const Route = createFileRoute('/_auth')({
  beforeLoad: async ({ context }) => {
    const user = await context.auth.validateAuth()
    if (!user) {
      clearSkipDeleteCookie()
      throw redirect({ to: '/login' })
    }
    return { user }
  },
  component: RouteComponent,
})

function RouteComponent() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: user } = useQuery(meQueryOptions)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSettled: async () => {
      clearSkipDeleteCookie()
      queryClient.clear()
      navigate({ to: '/login' })
    },
  })

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    if (menuOpen) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  function closeMenu() { setMenuOpen(false) }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-4 sm:px-6 h-14 flex items-center justify-between gap-3">

        {/* Left: brand + desktop nav */}
        <div className="flex items-center gap-5 min-w-0">
          <div className="flex items-center gap-2 shrink-0">
            <AppIcon size={26} />
            <span className="font-semibold text-gray-900 text-sm tracking-tight whitespace-nowrap">
              Apollo SFS
            </span>
          </div>
          <div className="hidden sm:flex items-center gap-1">
            <NavLink to="/client" exact onClick={closeMenu}>Files</NavLink>
            <NavLink to="/client/favorites" onClick={closeMenu}>Favorites</NavLink>
            {user?.is_admin && (
              <>
                <NavLink to="/admin/users" onClick={closeMenu}>Users</NavLink>
                <NavLink to="/admin/invitations" onClick={closeMenu}>Invitations</NavLink>
                <NavLink to="/admin/interest" onClick={closeMenu}>Interest</NavLink>
                <NavLink to="/admin/banned-ips" onClick={closeMenu}>Banned IPs</NavLink>
                <NavLink to="/admin/metrics" onClick={closeMenu}>Metrics</NavLink>
                <NavLink to="/admin/alarm" onClick={closeMenu}>Alarms</NavLink>
              </>
            )}
          </div>
        </div>

        {/* Right: username + sign out + mobile toggle */}
        <div className="flex items-center gap-3 shrink-0">
          <Link
            to="/client/profile"
            className="text-sm text-gray-500 hover:text-gray-900 transition-colors truncate max-w-20 sm:max-w-36 md:max-w-56"
          >
            {user?.username}
          </Link>
          <button
            onClick={() => logoutMutation.mutate()}
            disabled={logoutMutation.isPending}
            className="hidden sm:block text-sm text-gray-500 hover:text-gray-900 disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            Sign out
          </button>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Toggle navigation"
            className="sm:hidden text-gray-500 hover:text-gray-900 cursor-pointer"
          >
            {menuOpen ? <MdClose className="text-xl" /> : <MdMenu className="text-xl" />}
          </button>
        </div>
      </nav>

      {/* Mobile dropdown */}
      {menuOpen && (
        <div
          ref={menuRef}
          className="sm:hidden bg-white border-b border-gray-200 px-4 py-3 flex flex-col gap-1"
        >
          <MobileNavLink to="/client" exact onClick={closeMenu}>Files</MobileNavLink>
          <MobileNavLink to="/client/favorites" onClick={closeMenu}>Favorites</MobileNavLink>
          {user?.is_admin && (
            <>
              <MobileNavLink to="/admin/users" onClick={closeMenu}>Users</MobileNavLink>
              <MobileNavLink to="/admin/invitations" onClick={closeMenu}>Invitations</MobileNavLink>
              <MobileNavLink to="/admin/interest" onClick={closeMenu}>Interest</MobileNavLink>
              <MobileNavLink to="/admin/banned-ips" onClick={closeMenu}>Banned IPs</MobileNavLink>
              <MobileNavLink to="/admin/metrics" onClick={closeMenu}>Metrics</MobileNavLink>
              <MobileNavLink to="/admin/alarm" onClick={closeMenu}>Alarms</MobileNavLink>
            </>
          )}
          <div className="mt-2 pt-2 border-t border-gray-100">
            <button
              onClick={() => { logoutMutation.mutate(); closeMenu() }}
              disabled={logoutMutation.isPending}
              className="w-full text-left px-3 py-2 rounded-md text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors disabled:opacity-50 cursor-pointer"
            >
              Sign out
            </button>
          </div>
        </div>
      )}

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  )
}

interface NavLinkProps {
  to: string
  exact?: boolean
  onClick?: () => void
  children: React.ReactNode
}

function NavLink({ to, exact, onClick, children }: NavLinkProps) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: !!exact }}
      onClick={onClick}
      className="px-3 py-1.5 rounded-md text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors"
      activeProps={{ className: 'px-3 py-1.5 rounded-md text-sm text-blue-600 bg-blue-50 font-medium' }}
    >
      {children}
    </Link>
  )
}

function MobileNavLink({ to, exact, onClick, children }: NavLinkProps) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: !!exact }}
      onClick={onClick}
      className="px-3 py-2 rounded-md text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors"
      activeProps={{ className: 'px-3 py-2 rounded-md text-sm text-blue-600 bg-blue-50 font-medium' }}
    >
      {children}
    </Link>
  )
}
