import { useState } from 'react'
import { createRoute, redirect, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Route as RootRoute } from './Root'
import { register } from '../api/auth'
import { meQueryOptions } from '../api/me'
import { ApiError } from '../api/client'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/register',
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : '',
  }),
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.fetchQuery(meQueryOptions).catch(() => null)
    if (user) throw redirect({ to: '/dashboard' })
  },
  component: RegisterPage,
})

function RegisterPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { token } = useSearch({ from: '/register' })

  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => register(username, email, password, token),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      navigate({ to: '/dashboard' })
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Registration failed')
    },
  })

  if (!token) {
    return (
      <div style={{ maxWidth: 360, margin: '120px auto', padding: 24 }}>
        <p>Invalid or missing invite link.</p>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 360, margin: '120px auto', padding: 24 }}>
      <h1>Create account</h1>
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
          <div>Email</div>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
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
            autoComplete="new-password"
            minLength={8}
            required
            style={{ width: '100%', marginBottom: 12 }}
          />
        </label>
        {error && <p style={{ color: 'red' }}>{error}</p>}
        <button type="submit" disabled={mutation.isPending} style={{ width: '100%' }}>
          {mutation.isPending ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </div>
  )
}
