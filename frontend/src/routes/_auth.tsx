import { createFileRoute, Link, Outlet, redirect, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { meQueryOptions } from '../api/me'
import { logout } from '../api/auth'

export const Route = createFileRoute('/_auth')({
  beforeLoad: async ({ context }) => {
    const user = await context.auth.validateAuth()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  component: RouteComponent,
})

function RouteComponent() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: user } = useQuery(meQueryOptions)

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSettled: async () => {
      queryClient.clear()
      navigate({ to: '/login' })
    },
  })

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <span className="font-semibold text-gray-900 text-sm tracking-tight">Apollo SFS</span>
          <div className="flex items-center gap-1">
            <NavLink to="/client">Files</NavLink>
            <NavLink to="/client/favorites">Favorites</NavLink>
            {user?.is_admin && (
              <>
                <NavLink to="/admin/users">Users</NavLink>
                <NavLink to="/admin/invitations">Invitations</NavLink>
                <NavLink to="/admin/metrics">Metrics</NavLink>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Link
            to="/client/profile"
            className="text-sm text-gray-500 hover:text-gray-900 transition-colors"
          >
            {user?.username}
          </Link>
          <button
            onClick={() => logoutMutation.mutate()}
            disabled={logoutMutation.isPending}
            className="text-sm text-gray-500 hover:text-gray-900 disabled:opacity-50 cursor-pointer"
          >
            Sign out
          </button>
        </div>
      </nav>
      <main className="max-w-5xl mx-auto px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="px-3 py-1.5 rounded-md text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors"
      activeProps={{ className: 'px-3 py-1.5 rounded-md text-sm text-blue-600 bg-blue-50 font-medium' }}
    >
      {children}
    </Link>
  )
}
