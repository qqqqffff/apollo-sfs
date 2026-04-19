import { createRoute, Outlet, redirect, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Route as RootRoute } from './Root'
import { meQueryOptions } from '../api/me'
import { logout } from '../api/auth'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  id: '_auth',
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.fetchQuery(meQueryOptions).catch(() => null)
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  component: AuthLayout,
})

function AuthLayout() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: user } = useQuery(meQueryOptions)

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSettled: async () => {
      await queryClient.clear()
      navigate({ to: '/login' })
    },
  })

  return (
    <div>
      <nav style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid #ddd' }}>
        <div style={{ display: 'flex', gap: 16 }}>
          <a href="/dashboard">Files</a>
          <a href="/favorites">Favorites</a>
          {user?.is_admin && (
            <>
              <a href="/admin/users">Users</a>
              <a href="/admin/invitations">Invitations</a>
              <a href="/admin/metrics">Metrics</a>
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>{user?.username}</span>
          <button onClick={() => logoutMutation.mutate()} disabled={logoutMutation.isPending}>
            Sign out
          </button>
        </div>
      </nav>
      <main style={{ padding: 24 }}>
        <Outlet />
      </main>
    </div>
  )
}
