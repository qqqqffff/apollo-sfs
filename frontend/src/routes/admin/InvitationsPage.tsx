import { useState } from 'react'
import { createRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Route as AdminLayout } from '../AdminLayout'
import {
  adminInvitationsQueryOptions,
  createInvitation,
  revokeInvitation,
} from '../../api/admin'
import { ApiError } from '../../api/client'

export const Route = createRoute({
  getParentRoute: () => AdminLayout,
  path: '/admin/invitations',
  component: InvitationsPage,
})

function InvitationsPage() {
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery(adminInvitationsQueryOptions)
  const [email, setEmail] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  const createMutation = useMutation({
    mutationFn: () => createInvitation(email),
    onSuccess: () => {
      setEmail('')
      setCreateError(null)
      queryClient.invalidateQueries({ queryKey: ['admin', 'invitations'] })
    },
    onError: (err) => {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to create invitation')
    },
  })

  const revokeMutation = useMutation({
    mutationFn: revokeInvitation,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'invitations'] }),
  })

  if (isLoading) return <p>Loading…</p>
  if (error) return <p>Failed to load invitations.</p>

  const invitations = data?.items ?? []

  return (
    <div>
      <h2>Invitations</h2>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          setCreateError(null)
          createMutation.mutate()
        }}
        style={{ display: 'flex', gap: 8, marginBottom: 24 }}
      >
        <input
          type="email"
          placeholder="Email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ flex: 1 }}
        />
        <button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending ? 'Sending…' : 'Invite'}
        </button>
      </form>
      {createError && <p style={{ color: 'red' }}>{createError}</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Email', 'Expires', 'Status', ''].map((h) => (
              <th key={h} style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid #ddd' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {invitations.map((inv) => {
            const status = inv.accepted_at
              ? 'Accepted'
              : inv.revoked_at
                ? 'Revoked'
                : 'Pending'
            return (
              <tr key={inv.id}>
                <td style={{ padding: '4px 8px' }}>{inv.email}</td>
                <td style={{ padding: '4px 8px' }}>
                  {new Date(inv.token_expires_at).toLocaleDateString()}
                </td>
                <td style={{ padding: '4px 8px' }}>{status}</td>
                <td style={{ padding: '4px 8px' }}>
                  {status === 'Pending' && (
                    <button
                      onClick={() => {
                        if (confirm(`Revoke invitation for ${inv.email}?`)) {
                          revokeMutation.mutate(inv.id)
                        }
                      }}
                      style={{ fontSize: 12 }}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
