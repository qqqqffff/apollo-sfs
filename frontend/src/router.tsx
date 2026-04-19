import { createRouter, createRoute, redirect } from '@tanstack/react-router'
import { Route as RootRoute } from './routes/Root'
import { Route as LoginRoute } from './routes/LoginPage'
import { Route as RegisterRoute } from './routes/RegisterPage'
import { Route as AuthLayoutRoute } from './routes/AuthLayout'
import { Route as DashboardRoute } from './routes/DashboardPage'
import { Route as FolderRoute } from './routes/FolderPage'
import { Route as FavoritesRoute } from './routes/FavoritesPage'
import { Route as AdminLayoutRoute } from './routes/AdminLayout'
import { Route as UsersRoute } from './routes/admin/UsersPage'
import { Route as InvitationsRoute } from './routes/admin/InvitationsPage'
import { Route as MetricsRoute } from './routes/admin/MetricsPage'
import type { RouterContext } from './routes/Root'

const indexRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/dashboard' })
  },
})

const routeTree = RootRoute.addChildren([
  indexRoute,
  LoginRoute,
  RegisterRoute,
  AuthLayoutRoute.addChildren([
    DashboardRoute,
    FolderRoute,
    FavoritesRoute,
    AdminLayoutRoute.addChildren([
      UsersRoute,
      InvitationsRoute,
      MetricsRoute,
    ]),
  ]),
])

export function createAppRouter(context: RouterContext) {
  return createRouter({ routeTree, context })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
