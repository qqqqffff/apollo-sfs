import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MdCheck, MdClose, MdEdit, MdInfoOutline, MdBlock, MdLockClock, MdLockOpen } from 'react-icons/md'
import {
  adminUsersInfiniteQueryOptions,
  getAdminAuditLogs,
  logImpersonationAccess,
  updateUserQuota,
  updateUsername,
  banUser,
  suspendUser,
  pardonUser,
} from '../../api/admin'
import { ApiError } from '../../api/client'
import { meQueryOptions } from '../../api/me'
import type { AuditLog, User, UserBan } from '../../types/api'
import { VIOLATION_CODES } from '../../types/api'
import { useNotification } from '../../context/NotificationContext'
import { useImpersonation } from '../../context/ImpersonationContext'
import { BanSuspendModal } from '../../components/BanSuspendModal'

export const Route = createFileRoute('/_auth/admin/users')({
  component: RouteComponent,
})

const GB = 1024 ** 3
const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000

function isActive(user: User): boolean {
  if (!user.last_seen_at) return false
  return Date.now() - new Date(user.last_seen_at).getTime() < ACTIVE_THRESHOLD_MS
}

// ── Action label + colour ─────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  impersonation_access: 'Account accessed by admin',
  file_uploaded:        'File uploaded',
  file_upload_started:  'File upload started',
  folder_created:       'Folder created',
  file_favorited:       'File favorited',
  folder_favorited:     'Folder favorited',
  file_unfavorited:     'File unfavorited',
  folder_unfavorited:   'Folder unfavorited',
  file_deleted:         'File deleted',
  file_renamed:         'File renamed',
  folder_renamed:       'Folder renamed',
}

const ACTION_COLOURS: Record<string, string> = {
  impersonation_access: 'bg-orange-100 text-orange-700',
  file_uploaded:        'bg-green-100 text-green-700',
  file_upload_started:  'bg-blue-100 text-blue-700',
  folder_created:       'bg-blue-100 text-blue-700',
  file_favorited:       'bg-yellow-100 text-yellow-700',
  folder_favorited:     'bg-yellow-100 text-yellow-700',
  file_unfavorited:     'bg-gray-100 text-gray-500',
  folder_unfavorited:   'bg-gray-100 text-gray-500',
  file_deleted:         'bg-red-100 text-red-700',
  file_renamed:         'bg-purple-100 text-purple-700',
  folder_renamed:       'bg-purple-100 text-purple-700',
}

// ── Audit log modal ───────────────────────────────────────────────────────────

function AuditLogModal({ username, onClose }: { username: string; onClose: () => void }) {
  const { data, isLoading, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteQuery({
      queryKey: ['admin', 'audit', username],
      queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
        getAdminAuditLogs(username, pageParam),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last) => last.next_token || undefined,
    })

  const logs: AuditLog[] = data?.pages.flatMap((p) => p.items) ?? []

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-800">
            Audit log — <span className="text-blue-600">{username}</span>
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0"
          >
            <MdClose className="text-lg" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-3">
          {isLoading && <p className="text-sm text-gray-400 py-4 text-center">Loading…</p>}
          {error && <p className="text-sm text-red-500 py-4 text-center">Failed to load audit logs.</p>}
          {!isLoading && logs.length === 0 && (
            <p className="text-sm text-gray-400 py-4 text-center">No audit records yet.</p>
          )}

          <ul className="space-y-2">
            {logs.map((log) => (
              <li key={log.id} className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${ACTION_COLOURS[log.action] ?? 'bg-gray-100 text-gray-600'}`}
                    >
                      {ACTION_LABELS[log.action] ?? log.action}
                    </span>
                    {log.actor_username !== log.target_username && (
                      <span className="text-xs text-orange-500 font-medium">
                        by {log.actor_username}
                      </span>
                    )}
                  </div>
                  {log.resource_name && (
                    <p className="text-xs text-gray-600 mt-0.5 truncate">{log.resource_name}</p>
                  )}
                </div>
                <time className="text-xs text-gray-400 whitespace-nowrap shrink-0 mt-0.5">
                  {new Date(log.created_at).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>

          {hasNextPage && (
            <button
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="mt-3 w-full text-sm text-blue-600 hover:text-blue-700 cursor-pointer bg-transparent border-0 disabled:opacity-50"
            >
              {isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Ban status badge ──────────────────────────────────────────────────────────

function BanBadge({ ban }: { ban: UserBan | null | undefined }) {
  if (!ban) return <span className="text-gray-300 text-xs">—</span>
  if (ban.ban_type === 'banned') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700">
        <MdBlock className="text-xs" /> Banned
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
      <MdLockClock className="text-xs" /> Suspended
    </span>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type BanModal = { username: string; mode: 'ban' | 'suspend' }

function RouteComponent() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const { impersonate } = useImpersonation()
  const { data, isLoading, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteQuery(adminUsersInfiniteQueryOptions)
  const { data: me } = useQuery(meQueryOptions)

  const [auditUser, setAuditUser] = useState<string | null>(null)
  const [banModal, setBanModal] = useState<BanModal | null>(null)

  function viewUserFiles(u: User) {
    impersonate(u)
    logImpersonationAccess(u.username).catch(() => {})
    navigate({ to: '/client', search: { file: undefined, folder: undefined } })
  }

  const [editingUsername, setEditingUsername] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [quotaError, setQuotaError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const quotaMutation = useMutation({
    mutationFn: ({ username, gb }: { username: string; gb: number }) =>
      updateUserQuota(username, gb * GB),
    onSuccess: () => {
      setQuotaError(null)
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      notify('success', 'Storage quota updated')
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        const maxBytes = typeof err.body.max_bytes === 'number' ? err.body.max_bytes : null
        const drive = typeof err.body.drive_label === 'string' ? err.body.drive_label : null
        const maxGb = maxBytes !== null ? (maxBytes / GB).toFixed(1) : null
        const msg = maxGb
          ? `Drive capacity exceeded — max ${maxGb} GB${drive ? ` on ${drive}` : ''}`
          : 'Quota exceeds drive capacity'
        setQuotaError(msg)
      } else {
        notify('error', 'Failed to update storage quota')
      }
    },
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

  const banMutation = useMutation({
    mutationFn: ({ username, violationCode, comments }: { username: string; violationCode: string; comments: string }) =>
      banUser(username, violationCode, comments),
    onSuccess: () => {
      setBanModal(null)
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'bans'] })
      notify('success', 'User banned and files deleted')
    },
    onError: () => notify('error', 'Failed to ban user'),
  })

  const suspendMutation = useMutation({
    mutationFn: ({ username, violationCode, comments, hours }: { username: string; violationCode: string; comments: string; hours: number }) =>
      suspendUser(username, violationCode, comments, hours),
    onSuccess: () => {
      setBanModal(null)
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'bans'] })
      notify('success', 'User suspended')
    },
    onError: () => notify('error', 'Failed to suspend user'),
  })

  const pardonMutation = useMutation({
    mutationFn: (username: string) => pardonUser(username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'bans'] })
      notify('success', 'User pardoned')
    },
    onError: () => notify('error', 'Failed to pardon user'),
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

  function handleBanConfirm(violationCode: string, comments: string, hours?: number) {
    if (!banModal) return
    if (banModal.mode === 'ban') {
      banMutation.mutate({ username: banModal.username, violationCode, comments })
    } else {
      suspendMutation.mutate({ username: banModal.username, violationCode, comments, hours: hours! })
    }
  }

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (error) return <p className="text-sm text-red-500">Failed to load users.</p>

  const users = data?.pages.flatMap(p => p.items) ?? []

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-6 mt-0">Users</h2>

      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full min-w-225 text-sm border-collapse">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {['Username', 'Email', 'Used', 'Quota', 'Admin', 'Status', 'Last seen', ''].map((h) => (
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
              const ban = u.active_ban as UserBan | null | undefined
              const isBanned = ban?.ban_type === 'banned'
              const isSuspended = ban?.ban_type === 'suspended'

              return (
                <tr key={u.username} className={`hover:bg-gray-50 transition-colors ${isBanned ? 'bg-red-50/40' : isSuspended ? 'bg-amber-50/40' : ''}`}>
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
                        <button
                          onClick={() => viewUserFiles(u)}
                          title="View files as this user"
                          className="font-medium text-gray-900 hover:text-blue-600 cursor-pointer bg-transparent border-0 p-0 transition-colors"
                        >
                          {u.username}
                        </button>
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
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <BanBadge ban={ban} />
                      {ban && (
                        <span className="text-xs text-gray-400 truncate max-w-32" title={VIOLATION_CODES[ban.violation_code] ?? ban.violation_code}>
                          {VIOLATION_CODES[ban.violation_code] ?? ban.violation_code}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setAuditUser(u.username)}
                        title="View audit log"
                        className="text-gray-400 hover:text-blue-600 cursor-pointer bg-transparent border-0 p-0 transition-colors"
                      >
                        <MdInfoOutline className="text-base" />
                      </button>

                      {/* Ban / suspend / pardon */}
                      {ban ? (
                        <button
                          onClick={() => {
                            if (confirm(`Pardon ${u.username}? This will lift their ${ban.ban_type === 'banned' ? 'ban' : 'suspension'}.`))
                              pardonMutation.mutate(u.username)
                          }}
                          disabled={pardonMutation.isPending && pardonMutation.variables === u.username}
                          title="Pardon user"
                          className="inline-flex items-center gap-1 text-xs text-green-600 hover:text-green-800 cursor-pointer bg-transparent border border-green-200 hover:border-green-400 rounded px-2 py-1 transition-colors disabled:opacity-40"
                        >
                          <MdLockOpen className="text-sm" />
                          Pardon
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => setBanModal({ username: u.username, mode: 'suspend' })}
                            title="Suspend user"
                            className="text-amber-500 hover:text-amber-700 cursor-pointer bg-transparent border-0 p-0 transition-colors"
                          >
                            <MdLockClock className="text-base" />
                          </button>
                          <button
                            onClick={() => setBanModal({ username: u.username, mode: 'ban' })}
                            title="Ban user"
                            className="text-red-400 hover:text-red-700 cursor-pointer bg-transparent border-0 p-0 transition-colors"
                          >
                            <MdBlock className="text-base" />
                          </button>
                        </>
                      )}

                      <div className="flex flex-col gap-1">
                        <button
                          onClick={() => {
                            setQuotaError(null)
                            const raw = prompt(`New quota for ${u.username} (GB)`, String(u.storage_quota_bytes / GB | 0))
                            const gb = Number(raw)
                            if (raw && !isNaN(gb) && gb >= 0) quotaMutation.mutate({ username: u.username, gb })
                          }}
                          className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer bg-transparent border border-blue-200 hover:border-blue-400 rounded px-2 py-1 transition-colors"
                        >
                          Set quota
                        </button>
                        {quotaError && quotaMutation.variables?.username === u.username && (
                          <span className="text-xs text-red-500">{quotaError}</span>
                        )}
                      </div>
                    </div>
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

      {auditUser && (
        <AuditLogModal username={auditUser} onClose={() => setAuditUser(null)} />
      )}

      {banModal && (
        <BanSuspendModal
          username={banModal.username}
          mode={banModal.mode}
          onConfirm={handleBanConfirm}
          onClose={() => setBanModal(null)}
          isPending={banMutation.isPending || suspendMutation.isPending}
        />
      )}
    </div>
  )
}
