import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { useAuth } from '../auth';

export const Route = createFileRoute('/_auth')({
  beforeLoad: async ({ location }) => {
    // This will be handled in the component, but for now, placeholder
  },
  component: AuthLayout,
});

function AuthLayout() {
  const { isAuthenticated, isAdmin } = useAuth();

  if (!isAuthenticated) {
    throw redirect({
      to: '/login',
      search: {},
    });
  }

  return <Outlet />;
}
