import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteEmail,
  emailsInfiniteQueryOptions,
  emailWorkersQueryOptions,
  getEmail,
  markEmailRead,
} from '../../api/inboundEmails'
import { ApiError } from '../../api/client'
import { useNotification } from '../../context/NotificationContext'
import type { EmailDetail } from '../../types/inboundEmail'

export const Route = createFileRoute('/_auth/admin/emails')({
  component: RouteComponent,
})

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function RouteComponent() {
  const queryClient = useQueryClient()
  const { notify } = useNotification()

  const [selectedWorker, setSelectedWorker] = useState<string | undefined>(undefined)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // ── Workers (sidebar) ──────────────────────────────────────────────────────
  const { data: workersData, isLoading: workersLoading } = useQuery(emailWorkersQueryOptions)
  const workers = workersData?.workers ?? []
  const totalAll = workers.reduce((n, w) => n + w.total_count, 0)
  const unreadAll = workers.reduce((n, w) => n + w.unread_count, 0)

  // ── Email list (centre) ────────────────────────────────────────────────────
  const {
    data: listData,
    isLoading: listLoading,
    error: listError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery(emailsInfiniteQueryOptions(selectedWorker))
  const emails = useMemo(() => listData?.pages.flatMap(p => p.items ?? []) ?? [], [listData])

  // ── Detail (right) ─────────────────────────────────────────────────────────
  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['admin', 'emails', 'detail', selectedId],
    queryFn: () => getEmail(selectedId as string),
    enabled: !!selectedId,
  })

  const invalidateLists = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'emails', 'list'] })
    queryClient.invalidateQueries({ queryKey: ['admin', 'emails', 'workers'] })
  }

  const markReadMutation = useMutation({
    mutationFn: (id: string) => markEmailRead(id),
    onSuccess: invalidateLists,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteEmail(id),
    onSuccess: () => {
      invalidateLists()
      setSelectedId(null)
      setConfirmDelete(false)
      notify('success', 'Email deleted')
    },
    onError: (err) => {
      notify('error', err instanceof ApiError ? err.message : 'Failed to delete email')
    },
  })

  // Opening an unread email marks it read (once per selection).
  const markedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedId || !detail || detail.read) return
    if (markedRef.current === selectedId) return
    markedRef.current = selectedId
    markReadMutation.mutate(selectedId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, detail])

  function selectEmail(id: string) {
    setSelectedId(id)
    setConfirmDelete(false)
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-6 mt-0">Service emails</h2>

      <div className="flex gap-4 h-[calc(100vh-220px)] min-h-100">
        {/* ── Worker sidebar ───────────────────────────────────────────── */}
        <aside className="w-48 shrink-0 bg-white rounded-xl border border-gray-200 overflow-y-auto">
          <WorkerButton
            label="All"
            active={selectedWorker === undefined}
            unread={unreadAll}
            total={totalAll}
            onClick={() => { setSelectedWorker(undefined); setSelectedId(null) }}
          />
          {workersLoading && (
            <p className="px-3 py-2 text-xs text-gray-400">Loading…</p>
          )}
          {!workersLoading && workers.length === 0 && (
            <p className="px-3 py-2 text-xs text-gray-400">No mailboxes yet.</p>
          )}
          {workers.map((w) => (
            <WorkerButton
              key={w.worker_name}
              label={w.worker_name}
              active={selectedWorker === w.worker_name}
              unread={w.unread_count}
              total={w.total_count}
              onClick={() => { setSelectedWorker(w.worker_name); setSelectedId(null) }}
            />
          ))}
        </aside>

        {/* ── Email list ───────────────────────────────────────────────── */}
        <div className="w-80 shrink-0 bg-white rounded-xl border border-gray-200 overflow-y-auto">
          {listLoading && <p className="px-4 py-3 text-sm text-gray-400">Loading…</p>}
          {listError && <p className="px-4 py-3 text-sm text-red-500">Failed to load emails.</p>}
          {!listLoading && emails.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-gray-400">No emails.</p>
          )}
          <ul className="divide-y divide-gray-100">
            {emails.map((e) => (
              <li key={e.id}>
                <button
                  onClick={() => selectEmail(e.id)}
                  className={`w-full text-left px-4 py-3 cursor-pointer transition-colors border-0 bg-transparent ${
                    selectedId === e.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {!e.read && <span className="w-2 h-2 rounded-full bg-blue-600 shrink-0" aria-label="unread" />}
                    <span className={`text-sm truncate ${e.read ? 'text-gray-600' : 'text-gray-900 font-semibold'}`}>
                      {e.from_addr}
                    </span>
                    <span className="ml-auto text-[11px] text-gray-400 whitespace-nowrap">{formatDate(e.received_at)}</span>
                  </div>
                  <div className={`text-xs truncate mt-0.5 ${e.read ? 'text-gray-500' : 'text-gray-800'}`}>
                    {e.subject || '(no subject)'}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    {selectedWorker === undefined && (
                      <span className="text-[10px] text-gray-400 bg-gray-100 rounded px-1.5 py-0.5">{e.worker_name}</span>
                    )}
                    {e.has_attachments && (
                      <span className="text-[10px] text-gray-400">📎 attachment</span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {hasNextPage && (
            <button
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="w-full py-2 text-sm text-blue-600 hover:text-blue-700 cursor-pointer bg-transparent border-0 disabled:opacity-50"
            >
              {isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>

        {/* ── Detail pane ──────────────────────────────────────────────── */}
        <div className="flex-1 bg-white rounded-xl border border-gray-200 overflow-y-auto">
          {!selectedId && (
            <div className="h-full flex items-center justify-center text-sm text-gray-400">
              Select an email to read it.
            </div>
          )}
          {selectedId && detailLoading && (
            <p className="px-6 py-4 text-sm text-gray-400">Loading…</p>
          )}
          {selectedId && detail && (
            <EmailDetailView
              detail={detail}
              confirmDelete={confirmDelete}
              deleting={deleteMutation.isPending}
              onAskDelete={() => setConfirmDelete(true)}
              onCancelDelete={() => setConfirmDelete(false)}
              onConfirmDelete={() => deleteMutation.mutate(detail.id)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function WorkerButton(props: {
  label: string
  active: boolean
  unread: number
  total: number
  onClick: () => void
}) {
  const { label, active, unread, total, onClick } = props
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer border-0 transition-colors ${
        active ? 'bg-blue-50 text-blue-800' : 'bg-transparent text-gray-700 hover:bg-gray-50'
      }`}
    >
      <span className="text-sm truncate">{label}</span>
      {unread > 0 ? (
        <span className="ml-auto text-[11px] font-semibold bg-blue-600 text-white rounded-full px-1.5 py-0.5 min-w-5 text-center">
          {unread}
        </span>
      ) : (
        <span className="ml-auto text-[11px] text-gray-400">{total}</span>
      )}
    </button>
  )
}

function EmailDetailView(props: {
  detail: EmailDetail
  confirmDelete: boolean
  deleting: boolean
  onAskDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
}) {
  const { detail, confirmDelete, deleting, onAskDelete, onCancelDelete, onConfirmDelete } = props
  const msg = detail.message
  const [bodyHtml, setBodyHtml] = useState<string | null>(null)

  // Sanitize the HTML body before it is dropped into a sandboxed iframe.
  useEffect(() => {
    let cancelled = false
    if (!msg.html) { setBodyHtml(null); return }
    void (async () => {
      const DOMPurify = (await import('dompurify')).default
      const clean = DOMPurify.sanitize(msg.html)
      if (!cancelled) setBodyHtml(clean)
    })()
    return () => { cancelled = true }
  }, [msg.html])

  return (
    <div className="p-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-gray-900 mt-0 mb-1 break-words">
            {msg.subject || '(no subject)'}
          </h3>
          <p className="text-xs text-gray-600 m-0">
            <span className="font-medium">From:</span> {msg.from}
          </p>
          <p className="text-xs text-gray-600 m-0">
            <span className="font-medium">To:</span> {msg.to}
          </p>
          <p className="text-xs text-gray-400 mt-1 mb-0">{formatDate(detail.received_at)}</p>
        </div>
        <div className="ml-auto shrink-0">
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <button
                onClick={onConfirmDelete}
                disabled={deleting}
                className="px-3 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded-md disabled:opacity-50 transition-colors cursor-pointer"
              >
                {deleting ? 'Deleting…' : 'Confirm delete'}
              </button>
              <button
                onClick={onCancelDelete}
                className="px-3 py-1 text-xs text-gray-500 hover:text-gray-800 border border-gray-200 rounded-md transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={onAskDelete}
              className="px-3 py-1 text-xs text-red-600 hover:text-red-800 border border-red-200 hover:border-red-400 rounded-md transition-colors cursor-pointer bg-transparent"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {detail.has_attachments && msg.attachments.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {msg.attachments.map((a, i) => (
            <span
              key={`${a.filename}-${i}`}
              className="text-xs text-gray-600 bg-gray-100 rounded-md px-2 py-1"
              title={`${a.content_type} · ${a.size} bytes`}
            >
              📎 {a.filename || 'attachment'}
            </span>
          ))}
        </div>
      )}

      <div className="mt-5 border-t border-gray-100 pt-4">
        {bodyHtml !== null ? (
          <iframe
            title="email body"
            sandbox=""
            srcDoc={bodyHtml}
            className="w-full h-[55vh] border border-gray-100 rounded-lg bg-white"
          />
        ) : (
          <pre className="text-sm text-gray-800 whitespace-pre-wrap break-words font-sans m-0">
            {msg.text || '(no body)'}
          </pre>
        )}
      </div>
    </div>
  )
}
