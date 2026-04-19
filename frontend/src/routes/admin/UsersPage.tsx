import { createRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Route as AdminLayout } from '../AdminLayout'
import { adminUsersQueryOptions, updateUserQuota } from '../../api/admin'

export const Route = createRoute({
  getParentRoute: () => AdminLayout,
  path: '/admin/users',
  component: UsersPage,
})

const GB = 1024 ** 3

function UsersPage() {
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery(adminUsersQueryOptions)

  const quotaMutation = useMutation({
    mutationFn: ({ username, gb }: { username: string; gb: number }) =>
      updateUserQuota(username, gb * GB),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  })

  if (isLoading) return <p>Loading…</p>
  if (error) return <p>Failed to load users.</p>

  const users = data?.items ?? []

  return (
    <div>
      <h2>Users</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Username', 'Email', 'Used', 'Quota', 'Admin', 'Last seen', ''].map((h) => (
              <th key={h} style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid #ddd' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.username}>
              <td style={{ padding: '4px 8px' }}>{u.username}</td>
              <td style={{ padding: '4px 8px' }}>{u.email}</td>
              <td style={{ padding: '4px 8px' }}>{(u.storage_used_bytes / GB).toFixed(2)} GB</td>
              <td style={{ padding: '4px 8px' }}>{(u.storage_quota_bytes / GB).toFixed(0)} GB</td>
              <td style={{ padding: '4px 8px' }}>{u.is_admin ? '✓' : ''}</td>
              <td style={{ padding: '4px 8px' }}>
                {u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : '—'}
              </td>
              <td style={{ padding: '4px 8px' }}>
                <button
                  onClick={() => {
                    const raw = prompt(`New quota for ${u.username} (GB)`, String(u.storage_quota_bytes / GB | 0))
                    const gb = Number(raw)
                    if (raw && !isNaN(gb) && gb >= 0) quotaMutation.mutate({ username: u.username, gb })
                  }}
                  style={{ fontSize: 12 }}
                >
                  Set quota
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
