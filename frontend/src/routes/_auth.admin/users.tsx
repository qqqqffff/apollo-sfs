import { createFileRoute } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MdCheck, MdClose, MdEdit } from 'react-icons/md'
import { adminUsersInfiniteQueryOptions, updateUserQuota, updateUsername } from '../../api/admin'
import { meQueryOptions } from '../../api/me'
import type { User } from '../../types/api'
import { useNotification } from '../../context/NotificationContext'

export const Route = createFileRoute('/_auth/admin/users')({
  component: RouteComponent,
})

const GB = 1024 ** 3
const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000

function isActive(user: User): boolean {
  if (!user.last_seen_at) return false
  return Date.now() - new Date(user.last_seen_at).getTime() < ACTIVE_THRESHOLD_MS
}

function RouteComponent() {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const { data, isLoading, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteQuery(adminUsersInfiniteQueryOptions)
  const { data: me } = useQuery(meQueryOptions)
  const [editingUsername, setEditingUsername] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const quotaMutation = useMutation({
    mutationFn: ({ username, gb }: { username: string; gb: number }) =>
      updateUserQuota(username, gb * GB),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      notify('success', 'Storage quota updated')
    },
    onError: () => notify('error', 'Failed to update storage quota'),
  })

  const renameMutation = useMutation({
    mutationFn: ({ username, newUsername }: { username: string; newUsername: string }) =>
      updateUsername(username, newUsername),
    onSuccess: (_data, { username }) => {
      setEditingUsername(null)
      setEditValue('')
      setEditError(null)
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      if (username === me?.username) {
        queryClient.invalidateQueries({ queryKey: ['me'] })
      }
    },
    onError: (err: Error) => {
      setEditError(err.message ?? 'Failed to rename user')
    },
  })

  function startEdit(username: string) {
    setEditingUsername(username)
    setEditValue(username)
    setEditError(null)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function cancelEdit() {
    setEditingUsername(null)
    setEditValue('')
    setEditError(null)
  }

  function confirmEdit(username: string) {
    const trimmed = editValue.trim()
    if (trimmed.length < 3) return
    if (trimmed === username) { cancelEdit(); return }
    renameMutation.mutate({ username, newUsername: trimmed })
  }

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (error) return <p className="text-sm text-red-500">Failed to load users.</p>

  const users = data?.pages.flatMap(p => p.items) ?? []

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-6 mt-0">Users</h2>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {['Username', 'Email', 'Used', 'Quota', 'Admin', 'Last seen', ''].map((h) => (
                <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((u) => {
              const active = isActive(u)
              const editing = editingUsername === u.username

              return (
                <tr key={u.username} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {editing ? (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1">
                          <input
                            ref={inputRef}
                            type="text"
                            value={editValue}
                            onChange={(e) => { setEditValue(e.target.value); setEditError(null) }}
                            className="border border-gray-300 rounded px-2 py-0.5 text-sm w-36 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') confirmEdit(u.username)
                              if (e.key === 'Escape') cancelEdit()
                            }}
                          />
                          <button
                            onClick={() => confirmEdit(u.username)}
                            disabled={editValue.trim().length < 3 || renameMutation.isPending}
                            title="Confirm"
                            className="text-green-600 hover:text-green-800 disabled:opacity-40 cursor-pointer bg-transparent border-0 p-0"
                          >
                            <MdCheck className="text-base" />
                          </button>
                          <button
                            onClick={cancelEdit}
                            title="Cancel"
                            className="text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 p-0"
                          >
                            <MdClose className="text-base" />
                          </button>
                        </div>
                        {editError && (
                          <span className="text-xs text-red-500">{editError}</span>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span
                          title={active ? 'Active in last 5 min' : undefined}
                          className={`inline-block w-2 h-2 rounded-full shrink-0 ${active ? 'bg-green-500' : 'bg-gray-200'}`}
                        />
                        {u.username}
                        <button
                          onClick={() => startEdit(u.username)}
                          title="Edit username"
                          className="text-gray-300 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0 transition-colors"
                        >
                          <MdEdit className="text-sm" />
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{u.email}</td>
                  <td className="px-4 py-3 text-gray-600">{(u.storage_used_bytes / GB).toFixed(2)} GB</td>
                  <td className="px-4 py-3 text-gray-600">{(u.storage_quota_bytes / GB).toFixed(0)} GB</td>
                  <td className="px-4 py-3 text-blue-500">
                    {u.is_admin ? <MdCheck className="text-base" /> : null}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => {
                        const raw = prompt(`New quota for ${u.username} (GB)`, String(u.storage_quota_bytes / GB | 0))
                        const gb = Number(raw)
                        if (raw && !isNaN(gb) && gb >= 0) quotaMutation.mutate({ username: u.username, gb })
                      }}
                      className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer bg-transparent border border-blue-200 hover:border-blue-400 rounded px-2 py-1 transition-colors"
                    >
                      Set quota
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {hasNextPage && (
        <button
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="mt-3 text-sm text-blue-600 hover:text-blue-700 cursor-pointer bg-transparent border-0 disabled:opacity-50"
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
