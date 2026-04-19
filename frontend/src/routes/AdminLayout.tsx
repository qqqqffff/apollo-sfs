import { createRoute, Outlet, redirect } from '@tanstack/react-router'
import { Route as AuthLayout } from './AuthLayout'
import { meQueryOptions } from '../api/me'

export const Route = createRoute({
  getParentRoute: () => AuthLayout,
  id: '_admin',
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.fetchQuery(meQueryOptions).catch(() => null)
    if (!user?.is_admin) throw redirect({ to: '/dashboard' })
  },
  component: () => <Outlet />,
})
