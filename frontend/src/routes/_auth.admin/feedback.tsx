import { createFileRoute } from '@tanstack/react-router'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { MdArchive, MdCheckCircle, MdFeedback, MdReplay, MdSearch } from 'react-icons/md'
import { listFeedback, updateFeedbackStatus, searchAdminUsers, updateUserFeedbackAccess } from '../../api/admin'
import { useNotification } from '../../context/NotificationContext'
import { FEEDBACK_CATEGORIES, type Feedback, type FeedbackStatus, type User } from '../../types/api'

type Tab = 'submissions' | 'access'

export const Route = createFileRoute('/_auth/admin/feedback')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } => {
    const tab = search.tab === 'submissions' || search.tab === 'access' ? search.tab : undefined
    return { tab }
  },
  component: RouteComponent,
})

const TABS: { key: FeedbackStatus; label: string }[] = [
  { key: 'new', label: 'New' },
  { key: 'reviewed', label: 'Reviewed' },
  { key: 'archived', label: 'Archived' },
]

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

function CategoryBadge({ category }: { category: Feedback['category'] }) {
  const colors: Record<Feedback['category'], string> = {
    bug: 'bg-red-100 text-red-700',
    feature: 'bg-blue-100 text-blue-700',
    general: 'bg-gray-100 text-gray-600',
  }
  return (
    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${colors[category]}`}>
      {FEEDBACK_CATEGORIES[category]}
    </span>
  )
}

function RouteComponent() {
  const { tab } = Route.useSearch()
  const [activeTab, setActiveTab] = useState<Tab>(tab ?? 'submissions')

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-6 mt-0">Feedback</h2>

      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {([
          { key: 'submissions', label: 'Submissions' },
          { key: 'access',      label: 'Access' },
        ] as { key: Tab; label: string }[]).map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer ${
              activeTab === key
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'submissions' && <SubmissionsTab />}
      {activeTab === 'access' && <AccessTab />}
    </div>
  )
}

// ── Submissions ────────────────────────────────────────────────────────────────

function SubmissionsTab() {
  const [statusTab, setStatusTab] = useState<FeedbackStatus>('new')
  const queryClient = useQueryClient()
  const { notify } = useNotification()

  const {
    data,
    isLoading,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: ['admin', 'feedback', statusTab],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      listFeedback(statusTab, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_token || undefined,
  })

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: FeedbackStatus }) => updateFeedbackStatus(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'feedback'] })
      notify('success', 'Feedback updated')
    },
    onError: () => notify('error', 'Failed to update feedback'),
  })

  const items = data?.pages.flatMap((p) => p.items) ?? []

  return (
    <div>
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setStatusTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer ${
              statusTab === key
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-sm text-gray-400">Loading…</p>}

      {!isLoading && items.length === 0 && (
        <div className="flex flex-col items-center py-10 gap-2 text-gray-400">
          <MdFeedback className="text-4xl" />
          <p className="text-sm m-0">No {statusTab} feedback.</p>
        </div>
      )}

      {items.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table className="w-full min-w-175 text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['User', 'Category', 'Message', 'Submitted', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((item) => (
                <FeedbackRow
                  key={item.id}
                  item={item}
                  onSetStatus={(status) => statusMutation.mutate({ id: item.id, status })}
                  pending={statusMutation.isPending && statusMutation.variables?.id === item.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

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

function FeedbackRow({ item, onSetStatus, pending }: {
  item: Feedback
  onSetStatus: (status: FeedbackStatus) => void
  pending: boolean
}) {
  return (
    <tr className="hover:bg-gray-50 transition-colors align-top">
      <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">{item.username}</td>
      <td className="px-4 py-3"><CategoryBadge category={item.category} /></td>
      <td className="px-4 py-3 text-gray-600 text-xs max-w-96 whitespace-pre-wrap">{item.message}</td>
      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
        <span title={new Date(item.created_at).toLocaleString()}>
          {formatRelative(item.created_at)}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {item.status === 'new' && (
            <>
              <button
                onClick={() => onSetStatus('reviewed')}
                disabled={pending}
                title="Mark reviewed"
                className="inline-flex items-center gap-1 text-xs text-green-600 hover:text-green-800 cursor-pointer bg-transparent border border-green-200 hover:border-green-400 rounded px-2 py-1 transition-colors disabled:opacity-40"
              >
                <MdCheckCircle className="text-sm" /> Reviewed
              </button>
              <button
                onClick={() => onSetStatus('archived')}
                disabled={pending}
                title="Archive"
                className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 cursor-pointer bg-transparent border border-gray-200 hover:border-gray-400 rounded px-2 py-1 transition-colors disabled:opacity-40"
              >
                <MdArchive className="text-sm" /> Archive
              </button>
            </>
          )}
          {item.status === 'reviewed' && (
            <>
              <button
                onClick={() => onSetStatus('archived')}
                disabled={pending}
                title="Archive"
                className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 cursor-pointer bg-transparent border border-gray-200 hover:border-gray-400 rounded px-2 py-1 transition-colors disabled:opacity-40"
              >
                <MdArchive className="text-sm" /> Archive
              </button>
              <button
                onClick={() => onSetStatus('new')}
                disabled={pending}
                title="Reopen"
                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 cursor-pointer bg-transparent border border-blue-200 hover:border-blue-400 rounded px-2 py-1 transition-colors disabled:opacity-40"
              >
                <MdReplay className="text-sm" /> Reopen
              </button>
            </>
          )}
          {item.status === 'archived' && (
            <button
              onClick={() => onSetStatus('new')}
              disabled={pending}
              title="Reopen"
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 cursor-pointer bg-transparent border border-blue-200 hover:border-blue-400 rounded px-2 py-1 transition-colors disabled:opacity-40"
            >
              <MdReplay className="text-sm" /> Reopen
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}

// ── Access (per-user feedback form gate — disabled by default) ─────────────────

const ACCESS_PAGE_SIZE = 25

function AccessTab() {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [page, setPage] = useState(1)

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'feedback-access', { search, page }],
    queryFn: () => searchAdminUsers({ search, sort: 'username', dir: 'asc', page, page_size: ACCESS_PAGE_SIZE }),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ username, enabled }: { username: string; enabled: boolean }) =>
      updateUserFeedbackAccess(username, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'feedback-access'] })
      notify('success', 'Feedback access updated')
    },
    onError: () => notify('error', 'Failed to update feedback access'),
  })

  const users = data?.items ?? []
  const pageCount = data ? Math.max(1, Math.ceil(data.total / ACCESS_PAGE_SIZE)) : 1

  function submitSearch() {
    setSearch(draft.trim())
    setPage(1)
  }

  return (
    <div>
      <p className="text-xs text-gray-500 mb-4 max-w-2xl">
        Access to the feedback form is disabled by default. Enable it for individual users below
        so they see the &ldquo;Feedback&rdquo; option on their profile page.
      </p>

      <div className="flex items-center gap-2 mb-4">
        <div className="relative">
          <MdSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitSearch() }}
            onBlur={submitSearch}
            placeholder="Search username or email…"
            className="border border-gray-200 rounded-lg pl-8 pr-3 py-1.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
        <div className="ml-auto flex items-center gap-2 text-sm text-gray-500">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-2 py-1 border border-gray-200 rounded disabled:opacity-40 cursor-pointer bg-white hover:bg-gray-50"
          >
            ‹
          </button>
          <span>Page {page} of {pageCount}</span>
          <button
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            disabled={page >= pageCount}
            className="px-2 py-1 border border-gray-200 rounded disabled:opacity-40 cursor-pointer bg-white hover:bg-gray-50"
          >
            ›
          </button>
        </div>
      </div>

      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {error != null && <p className="text-sm text-red-500">Failed to load users.</p>}

      {data && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table className="w-full min-w-150 text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['Username', 'Email', 'Access', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">No users found.</td></tr>
              )}
              {users.map((u: User) => {
                const pending = toggleMutation.isPending && toggleMutation.variables?.username === u.username
                return (
                  <tr key={u.username} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900">{u.username}</td>
                    <td className="px-4 py-3 text-gray-500">{u.email}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${
                        u.feedback_access_enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}>
                        {u.feedback_access_enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => toggleMutation.mutate({ username: u.username, enabled: !u.feedback_access_enabled })}
                        disabled={pending}
                        className={`text-xs cursor-pointer rounded px-2 py-1 border transition-colors disabled:opacity-40 ${
                          u.feedback_access_enabled
                            ? 'text-gray-500 hover:text-gray-700 border-gray-200 hover:border-gray-400'
                            : 'text-blue-600 hover:text-blue-800 border-blue-200 hover:border-blue-400'
                        }`}
                      >
                        {pending ? 'Saving…' : u.feedback_access_enabled ? 'Revoke access' : 'Grant access'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
