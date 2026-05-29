import { createFileRoute, Link, Outlet, redirect, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useEffect, useRef } from 'react'
import { MdMenu, MdClose, MdBlock, MdLockClock, MdLockOpen, MdPerson } from 'react-icons/md'
import { AppIcon } from '../components/AppIcon'
import { meQueryOptions } from '../api/me'
import { logout } from '../api/auth'
import { banUser, suspendUser, pardonUser } from '../api/admin'
import { clearSkipDeleteCookie } from '../components/DeleteConfirmModal'
import { useImpersonation } from '../context/ImpersonationContext'
import { useNotification } from '../context/NotificationContext'
import { BanSuspendModal } from '../components/BanSuspendModal'
import type { UserBan } from '../types/api'

export const Route = createFileRoute('/_auth')({
  beforeLoad: async ({ context }) => {
    const result = await context.auth.validateAuth()
    if (result === 'banned' || result === 'suspended') {
      throw redirect({ to: '/suspended' })
    }
    if (!result) {
      clearSkipDeleteCookie()
      throw redirect({ to: '/login' })
    }
    return { user: result }
  },
  component: RouteComponent,
})

type BanModalMode = 'ban' | 'suspend'

function RouteComponent() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: user } = useQuery(meQueryOptions)
  const { impersonatedUser, clearImpersonation } = useImpersonation()
  const { notify } = useNotification()
  const [menuOpen, setMenuOpen] = useState(false)
  const [banModal, setBanModal] = useState<BanModalMode | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSettled: async () => {
      clearSkipDeleteCookie()
      queryClient.clear()
      navigate({ to: '/login' })
    },
  })

  const banMutation = useMutation({
    mutationFn: ({ violationCode, comments }: { violationCode: string; comments: string }) =>
      banUser(impersonatedUser!.username, violationCode, comments),
    onSuccess: () => {
      setBanModal(null)
      clearImpersonation()
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'bans'] })
      notify('success', 'User banned and files deleted')
      navigate({ to: '/admin/users' })
    },
    onError: () => notify('error', 'Failed to ban user'),
  })

  const suspendMutation = useMutation({
    mutationFn: ({ violationCode, comments, hours }: { violationCode: string; comments: string; hours: number }) =>
      suspendUser(impersonatedUser!.username, violationCode, comments, hours),
    onSuccess: () => {
      setBanModal(null)
      clearImpersonation()
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'bans'] })
      notify('success', 'User suspended')
      navigate({ to: '/admin/users' })
    },
    onError: () => notify('error', 'Failed to suspend user'),
  })

  const pardonMutation = useMutation({
    mutationFn: () => pardonUser(impersonatedUser!.username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'bans'] })
      notify('success', 'User pardoned')
    },
    onError: () => notify('error', 'Failed to pardon user'),
  })

  function handleBanConfirm(violationCode: string, comments: string, hours?: number) {
    if (banModal === 'ban') {
      banMutation.mutate({ violationCode, comments })
    } else {
      suspendMutation.mutate({ violationCode, comments, hours: hours! })
    }
  }

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

  const activeBan = impersonatedUser?.active_ban as UserBan | null | undefined
  const isImpersonatedBanned = activeBan?.ban_type === 'banned'
  const isImpersonatedSuspended = activeBan?.ban_type === 'suspended'

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
          <div className="hidden xl:flex items-center gap-1">
            <NavLink to="/client" exact onClick={closeMenu}>Files</NavLink>
            <NavLink to="/client/favorites" onClick={closeMenu}>Favorites</NavLink>
            {user?.is_admin && (
              <>
                <NavLink to="/admin/users" onClick={closeMenu}>Users</NavLink>
                <NavLink to="/admin/invitations" onClick={closeMenu}>Invitations</NavLink>
                <NavLink to="/admin/interest" onClick={closeMenu}>Interest</NavLink>
                <NavLink to="/admin/bans" onClick={closeMenu}>Bans & Suspensions</NavLink>
                <NavLink to="/admin/metrics" onClick={closeMenu}>Metrics</NavLink>
                <NavLink to="/admin/alarm" onClick={closeMenu}>Alarms</NavLink>
              </>
            )}
          </div>
        </div>

        {/* Right: impersonation badge + ban controls + username + sign out */}
        <div className="flex items-center gap-2 shrink-0">
          {impersonatedUser && (
            <>
              {/* Ban / suspend / pardon icons shown while impersonating */}
              {user?.is_admin && (
                <div className="hidden sm:flex items-center gap-1">
                  {isImpersonatedBanned || isImpersonatedSuspended ? (
                    <button
                      onClick={() => {
                        if (confirm(`Pardon ${impersonatedUser.username}?`))
                          pardonMutation.mutate()
                      }}
                      disabled={pardonMutation.isPending}
                      title="Pardon user"
                      className="flex items-center justify-center w-7 h-7 rounded-full text-green-600 hover:bg-green-100 cursor-pointer bg-transparent border-0 transition-colors disabled:opacity-40"
                    >
                      <MdLockOpen className="text-base" />
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => setBanModal('suspend')}
                        title="Suspend user"
                        className="flex items-center justify-center w-7 h-7 rounded-full text-amber-500 hover:bg-amber-100 cursor-pointer bg-transparent border-0 transition-colors"
                      >
                        <MdLockClock className="text-base" />
                      </button>
                      <button
                        onClick={() => setBanModal('ban')}
                        title="Ban user"
                        className="flex items-center justify-center w-7 h-7 rounded-full text-red-500 hover:bg-red-100 cursor-pointer bg-transparent border-0 transition-colors"
                      >
                        <MdBlock className="text-base" />
                      </button>
                    </>
                  )}
                </div>
              )}

              <button
                onClick={clearImpersonation}
                title="Exit impersonation — return to your own files"
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-200 cursor-pointer transition-colors whitespace-nowrap"
              >
                <span className="hidden sm:inline">Viewing</span>
                <span className="font-semibold">{impersonatedUser.username}</span>
                <MdClose className="text-sm" />
              </button>
            </>
          )}
          <Link
            to="/client/profile"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors truncate max-w-28 xl:max-w-40 2xl:max-w-56"
          >
            <MdPerson className="text-sm shrink-0" />
            <span className="truncate">{user?.username}</span>
          </Link>
          <button
            onClick={() => logoutMutation.mutate()}
            disabled={logoutMutation.isPending}
            className="hidden xl:block text-sm text-gray-500 hover:text-gray-900 disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            Sign out
          </button>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Toggle navigation"
            className="xl:hidden text-gray-500 hover:text-gray-900 cursor-pointer"
          >
            {menuOpen ? <MdClose className="text-xl" /> : <MdMenu className="text-xl" />}
          </button>
        </div>
      </nav>

      {/* Mobile dropdown */}
      {menuOpen && (
        <div
          ref={menuRef}
          className="xl:hidden bg-white border-b border-gray-200 px-4 py-3 flex flex-col gap-1"
        >
          <MobileNavLink to="/client" exact onClick={closeMenu}>Files</MobileNavLink>
          <MobileNavLink to="/client/favorites" onClick={closeMenu}>Favorites</MobileNavLink>
          {user?.is_admin && (
            <>
              <MobileNavLink to="/admin/users" onClick={closeMenu}>Users</MobileNavLink>
              <MobileNavLink to="/admin/invitations" onClick={closeMenu}>Invitations</MobileNavLink>
              <MobileNavLink to="/admin/interest" onClick={closeMenu}>Interest</MobileNavLink>
              <MobileNavLink to="/admin/bans" onClick={closeMenu}>Bans & Suspensions</MobileNavLink>
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

      {banModal && impersonatedUser && (
        <BanSuspendModal
          username={impersonatedUser.username}
          mode={banModal}
          onConfirm={handleBanConfirm}
          onClose={() => setBanModal(null)}
          isPending={banMutation.isPending || suspendMutation.isPending}
        />
      )}
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
