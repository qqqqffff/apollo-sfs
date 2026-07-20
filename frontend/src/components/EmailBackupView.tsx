import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MdAlternateEmail, MdArrowBack, MdAttachFile, MdStar } from 'react-icons/md'
import {
  deleteEmailBackupMessage,
  emailBackupMessagesInfiniteQueryOptions,
  emailBackupSendersQueryOptions,
  getEmailBackupMessage,
  markEmailBackupMessageRead,
} from '../api/emailBackup'
import { ApiError } from '../api/client'
import { useNotification } from '../context/NotificationContext'
import type { EmailBackupDetail } from '../types/emailBackup'
import type { Folder } from '../types/api'

interface Props {
  folder: Folder
  readOnly: boolean
  onBack: () => void
}

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

// EmailBackupView renders an email backup folder as a mail client instead of
// the standard file listing — the user-side twin of the admin service-email
// panel (sender sidebar → message list → reading pane) backed by the
// /email-backup endpoints, which decrypt messages on demand.
export function EmailBackupView({ folder, readOnly, onBack }: Props) {
  const queryClient = useQueryClient()
  const { notify } = useNotification()

  const [selectedSender, setSelectedSender] = useState<string | undefined>(undefined)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // ── Senders (sidebar) ──────────────────────────────────────────────────────
  const { data: sendersData, isLoading: sendersLoading } = useQuery(emailBackupSendersQueryOptions(folder.id))
  const senders = sendersData?.senders ?? []
  const totalAll = senders.reduce((n, s) => n + s.total_count, 0)
  const unreadAll = senders.reduce((n, s) => n + s.unread_count, 0)

  // ── Message list (centre) ──────────────────────────────────────────────────
  const {
    data: listData,
    isLoading: listLoading,
    error: listError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery(emailBackupMessagesInfiniteQueryOptions(folder.id, selectedSender))
  const emails = useMemo(() => listData?.pages.flatMap(p => p.items ?? []) ?? [], [listData])

  // ── Detail (right) ─────────────────────────────────────────────────────────
  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['email-backup', folder.id, 'detail', selectedId],
    queryFn: () => getEmailBackupMessage(selectedId as string),
    enabled: !!selectedId,
  })

  const invalidateLists = () => {
    queryClient.invalidateQueries({ queryKey: ['email-backup', folder.id, 'messages'] })
    queryClient.invalidateQueries({ queryKey: ['email-backup', folder.id, 'senders'] })
  }

  const markReadMutation = useMutation({
    mutationFn: (id: string) => markEmailBackupMessageRead(id),
    onSuccess: invalidateLists,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteEmailBackupMessage(id),
    onSuccess: () => {
      invalidateLists()
      queryClient.invalidateQueries({ queryKey: ['me'] })
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
    if (readOnly || !selectedId || !detail || detail.read) return
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
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 cursor-pointer bg-transparent border-0 p-0 transition-colors"
        >
          <MdArrowBack className="text-base" />
        </button>
        <MdAlternateEmail className="text-teal-500 text-xl" />
        <h2 className="text-lg font-semibold text-gray-900 m-0 truncate">{folder.name}</h2>
        <span className="text-xs text-gray-400 shrink-0">
          {totalAll} email{totalAll !== 1 ? 's' : ''} backed up
        </span>
      </div>

      <div className="flex gap-4 h-[calc(100vh-220px)] min-h-100">
        {/* ── Sender sidebar ────────────────────────────────────────────── */}
        <aside className="w-48 shrink-0 bg-white rounded-xl border border-gray-200 overflow-y-auto">
          <SenderButton
            label="All"
            active={selectedSender === undefined}
            unread={unreadAll}
            total={totalAll}
            onClick={() => { setSelectedSender(undefined); setSelectedId(null) }}
          />
          {sendersLoading && (
            <p className="px-3 py-2 text-xs text-gray-400">Loading…</p>
          )}
          {!sendersLoading && senders.length === 0 && (
            <p className="px-3 py-2 text-xs text-gray-400">No emails backed up yet.</p>
          )}
          {senders.map((s) => (
            <SenderButton
              key={s.from_addr}
              label={s.from_addr || '(unknown sender)'}
              active={selectedSender === s.from_addr}
              unread={s.unread_count}
              total={s.total_count}
              onClick={() => { setSelectedSender(s.from_addr); setSelectedId(null) }}
            />
          ))}
        </aside>

        {/* ── Email list ────────────────────────────────────────────────── */}
        <div className="w-80 shrink-0 bg-white rounded-xl border border-gray-200 overflow-y-auto">
          {listLoading && <p className="px-4 py-3 text-sm text-gray-400">Loading…</p>}
          {listError && <p className="px-4 py-3 text-sm text-red-500">Failed to load emails.</p>}
          {!listLoading && emails.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-gray-400">No emails.</p>
          )}
          <ul className="divide-y divide-gray-100 list-none m-0 p-0">
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
                      {e.from_addr || '(unknown sender)'}
                    </span>
                    <span className="ml-auto text-[11px] text-gray-400 whitespace-nowrap">{formatDate(e.received_at)}</span>
                  </div>
                  <div className={`text-xs truncate mt-0.5 ${e.read ? 'text-gray-500' : 'text-gray-800'}`}>
                    {e.subject || '(no subject)'}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    {e.starred && <MdStar className="text-amber-400 text-xs" title="Starred" />}
                    {e.has_attachments && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-gray-400">
                        <MdAttachFile className="text-xs" /> attachment
                      </span>
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

        {/* ── Detail pane ───────────────────────────────────────────────── */}
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
            <EmailBackupDetailView
              detail={detail}
              readOnly={readOnly}
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

function SenderButton(props: {
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

function EmailBackupDetailView(props: {
  detail: EmailBackupDetail
  readOnly: boolean
  confirmDelete: boolean
  deleting: boolean
  onAskDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
}) {
  const { detail, readOnly, confirmDelete, deleting, onAskDelete, onCancelDelete, onConfirmDelete } = props
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

  // Attachments were stored inline (base64) inside the encrypted document —
  // downloading one just materializes it as a blob locally.
  function downloadAttachment(index: number) {
    const a = msg.attachments[index]
    if (!a?.content_base64) return
    try {
      const binary = atob(a.content_base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const url = URL.createObjectURL(new Blob([bytes], { type: a.content_type || 'application/octet-stream' }))
      const link = document.createElement('a')
      link.href = url
      link.download = a.filename || 'attachment'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch { /* corrupt base64 — nothing to download */ }
  }

  return (
    <div className="p-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-gray-900 mt-0 mb-1 break-words">
            {detail.starred && <MdStar className="inline text-amber-400 text-base mr-1 align-text-bottom" />}
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
        {!readOnly && (
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
        )}
      </div>

      {detail.has_attachments && msg.attachments.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {msg.attachments.map((a, i) => (
            <button
              key={`${a.filename}-${i}`}
              onClick={() => downloadAttachment(i)}
              disabled={!a.content_base64}
              className="text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md px-2 py-1 border-0 cursor-pointer transition-colors disabled:cursor-default disabled:hover:bg-gray-100"
              title={`${a.content_type} · ${a.size} bytes${a.content_base64 ? ' — click to download' : ''}`}
            >
              📎 {a.filename || 'attachment'}
            </button>
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
