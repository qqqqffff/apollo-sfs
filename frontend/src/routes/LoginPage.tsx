import { useState } from 'react'
import { createRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Route as RootRoute } from './Root'
import { login } from '../api/auth'
import { meQueryOptions } from '../api/me'
import { ApiError } from '../api/client'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/login',
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.fetchQuery(meQueryOptions).catch(() => null)
    if (user) throw redirect({ to: '/dashboard' })
  },
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => login(username, password),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      navigate({ to: '/dashboard' })
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Login failed')
    },
  })

  return (
    <div style={{ maxWidth: 360, margin: '120px auto', padding: 24 }}>
      <h1>Sign in</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setError(null)
          mutation.mutate()
        }}
      >
        <label>
          <div>Username</div>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            style={{ width: '100%', marginBottom: 12 }}
          />
        </label>
        <label>
          <div>Password</div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            style={{ width: '100%', marginBottom: 12 }}
          />
        </label>
        {error && <p style={{ color: 'red' }}>{error}</p>}
        <button type="submit" disabled={mutation.isPending} style={{ width: '100%' }}>
          {mutation.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
