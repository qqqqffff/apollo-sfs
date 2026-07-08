import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MdAdd,
  MdCheck,
  MdClose,
  MdInfoOutline,
  MdReceiptLong,
  MdSearch,
} from 'react-icons/md'
import {
  approveExpansionRequest,
  cancelExpansionRequest,
  createExpansionInvoice,
  fulfillExpansionRequest,
  listAdminOrders,
  listExpansionRequests,
  refundAdminOrder,
  revertAdminOrderAllocation,
  type AdminInvoicePayload,
  type AdminOrder,
} from '../../api/admin'
import { ApiError } from '../../api/client'
import { useNotification } from '../../context/NotificationContext'
import { InvoiceDocument } from '../../components/InvoiceDocument'
import type { ServerExpansionRequest } from '../../types/api'

type Tab = 'orders' | 'expansion' | 'custom'

export const Route = createFileRoute('/_auth/admin/orders')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } => {
    const tab = search.tab === 'orders' || search.tab === 'expansion' || search.tab === 'custom'
      ? search.tab : undefined
    return { tab }
  },
  component: RouteComponent,
})

const PAGE_SIZE = 25
const DAY_MS = 24 * 60 * 60 * 1000
const REFUND_WINDOW_DAYS = 90
const TIB = 1024 ** 4

const METHOD_LABELS: Record<string, string> = {
  paypal: 'PayPal',
  card: 'Card entry',
  hosted_card: 'Card entry',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
  invoice: 'Invoice',
}

function fmtCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString() : '—'
}

function fmtCapacity(bytes: number): string {
  if (bytes >= 1024 * TIB) return `${(bytes / (1024 * TIB)).toFixed(1).replace(/\.0$/, '')} PB`
  if (bytes >= TIB) return `${(bytes / TIB).toFixed(1).replace(/\.0$/, '')} TB`
  return `${Math.round(bytes / 1024 ** 3)} GB`
}

// UserLink navigates to the admin users page with the user focused.
function UserLink({ username }: { username: string }) {
  return (
    <Link
      to="/admin/users"
      search={{ focus: username } as never}
      className="text-blue-600 hover:text-blue-700 hover:underline"
      title="Open in Users"
    >
      {username}
    </Link>
  )
}

function RouteComponent() {
  const { tab } = Route.useSearch()
  const [activeTab, setActiveTab] = useState<Tab>(tab ?? 'orders')

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-6 mt-0">Orders</h2>

      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {([
          { key: 'orders',    label: 'Orders' },
          { key: 'expansion', label: 'Expansion Requests' },
          { key: 'custom',    label: 'Custom Requests' },
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

      {activeTab === 'orders' && <OrdersTab />}
      {activeTab === 'expansion' && <RequestsTab custom={false} />}
      {activeTab === 'custom' && <RequestsTab custom={true} />}
    </div>
  )
}

// ── Shared search / sort / pagination bar ─────────────────────────────────────

function ListControls({
  search, onSearch, sort, onSort, sortOptions, page, pageCount, onPage,
}: {
  search: string
  onSearch: (v: string) => void
  sort: string
  onSort: (v: string) => void
  sortOptions: { value: string; label: string }[]
  page: number
  pageCount: number
  onPage: (p: number) => void
}) {
  const [draft, setDraft] = useState(search)
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <div className="relative">
        <MdSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSearch(draft.trim()) }}
          onBlur={() => onSearch(draft.trim())}
          placeholder="Search…"
          className="border border-gray-200 rounded-lg pl-8 pr-3 py-1.5 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>
      <select
        value={sort}
        onChange={(e) => onSort(e.target.value)}
        className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-700 cursor-pointer focus:outline-none"
      >
        {sortOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <div className="ml-auto flex items-center gap-2 text-sm text-gray-500">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          className="px-2 py-1 border border-gray-200 rounded disabled:opacity-40 cursor-pointer bg-white hover:bg-gray-50"
        >
          ‹
        </button>
        <span>Page {page} of {Math.max(pageCount, 1)}</span>
        <button
          onClick={() => onPage(page + 1)}
          disabled={page >= pageCount}
          className="px-2 py-1 border border-gray-200 rounded disabled:opacity-40 cursor-pointer bg-white hover:bg-gray-50"
        >
          ›
        </button>
      </div>
    </div>
  )
}

// ── Orders tab ────────────────────────────────────────────────────────────────

const ORDER_STATUS_COLORS: Record<string, string> = {
  captured: 'bg-green-100 text-green-700',
  created:  'bg-amber-100 text-amber-700',
  approved: 'bg-amber-100 text-amber-700',
  refunded: 'bg-gray-100 text-gray-500',
  failed:   'bg-red-100 text-red-600',
}

function OrdersTab() {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('date')
  const [page, setPage] = useState(1)
  const [infoOrder, setInfoOrder] = useState<AdminOrder | null>(null)
  const [refundTarget, setRefundTarget] = useState<AdminOrder | null>(null)
  const [revertTarget, setRevertTarget] = useState<AdminOrder | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'orders', { search, sort, page }],
    queryFn: () => listAdminOrders({ search, sort, page, page_size: PAGE_SIZE }),
  })

  const refundMutation = useMutation({
    mutationFn: (o: AdminOrder) => refundAdminOrder(o.type, o.id),
    onSuccess: () => {
      setRefundTarget(null)
      queryClient.invalidateQueries({ queryKey: ['admin', 'orders'] })
      notify('success', 'Refund issued')
    },
    onError: (err) => notify('error', err instanceof ApiError ? err.message : 'Refund failed'),
  })

  const revertMutation = useMutation({
    mutationFn: (o: AdminOrder) => revertAdminOrderAllocation(o.type, o.id),
    onSuccess: () => {
      setRevertTarget(null)
      queryClient.invalidateQueries({ queryKey: ['admin', 'orders'] })
      notify('success', 'Allocation reverted')
    },
    onError: (err) => notify('error', err instanceof ApiError ? err.message : 'Revert failed'),
  })

  const pageCount = data ? Math.ceil(data.total / PAGE_SIZE) : 1

  return (
    <div>
      <ListControls
        search={search} onSearch={(v) => { setSearch(v); setPage(1) }}
        sort={sort} onSort={(v) => { setSort(v); setPage(1) }}
        sortOptions={[
          { value: 'date', label: 'Newest first' },
          { value: 'amount', label: 'Largest payment first' },
        ]}
        page={page} pageCount={pageCount} onPage={setPage}
      />

      {isLoading && <p className="text-sm text-gray-400">Loading…</p>}
      {error != null && <p className="text-sm text-red-500">Failed to load orders.</p>}

      {data && (
        <div className="border border-gray-200 rounded-xl overflow-x-auto bg-white">
          <table className="w-full text-sm border-collapse min-w-225">
            <thead>
              <tr className="bg-gray-50 text-left text-xs text-gray-500">
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Payment date</th>
                <th className="px-3 py-2 font-medium">Method</th>
                <th className="px-3 py-2 font-medium">Reference</th>
                <th className="px-3 py-2 font-medium">Invoice #</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-400">No orders found.</td></tr>
              )}
              {data.items.map((o) => {
                const refundOpen = o.status === 'captured' && o.captured_at
                  && Date.now() - new Date(o.captured_at).getTime() <= REFUND_WINDOW_DAYS * DAY_MS
                const revertOpen = o.environment === 'sandbox' && o.status === 'captured' && !o.allocation_reverted_at
                const revertTitle = o.allocation_reverted_at
                  ? `Reverted ${fmtDate(o.allocation_reverted_at)}`
                  : o.environment !== 'sandbox'
                  ? 'Only sandbox orders can have their allocation reverted'
                  : o.status !== 'captured'
                  ? 'Order is not captured'
                  : 'Revert the granted quota/premium — no PayPal refund'
                return (
                  <tr key={`${o.type}-${o.id}`} className="border-t border-gray-100">
                    <td className="px-3 py-2"><UserLink username={o.username} /></td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded ${ORDER_STATUS_COLORS[o.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {o.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-medium text-gray-800">
                      {fmtCents(o.amount_cents)}
                      {o.environment === 'sandbox' && (
                        <span
                          title="Created via an admin's sandbox-payments toggle — not real revenue"
                          className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-purple-100 text-purple-700"
                        >
                          Sandbox
                        </span>
                      )}
                      {o.allocation_reverted_at && (
                        <span
                          title={`Allocation reverted ${fmtDate(o.allocation_reverted_at)}`}
                          className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-gray-100 text-gray-500"
                        >
                          Reverted
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-500">{fmtDate(o.captured_at ?? o.created_at)}</td>
                    <td className="px-3 py-2 text-gray-600">{METHOD_LABELS[o.payment_method] ?? o.payment_method}</td>
                    <td className="px-3 py-2 text-gray-400 font-mono text-xs">{o.reference}</td>
                    <td className="px-3 py-2 text-gray-500 font-mono text-xs">{o.invoice_number}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => setInfoOrder(o)}
                        title="Order info"
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 cursor-pointer transition-colors mr-1.5"
                      >
                        <MdInfoOutline /> Info
                      </button>
                      {o.environment === 'sandbox' && (
                        <button
                          onClick={() => setRevertTarget(o)}
                          disabled={!revertOpen}
                          title={revertTitle}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-purple-200 rounded-lg text-purple-600 hover:bg-purple-50 disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer disabled:cursor-not-allowed transition-colors mr-1.5"
                        >
                          Revert allocation
                        </button>
                      )}
                      <button
                        onClick={() => setRefundTarget(o)}
                        disabled={!refundOpen}
                        title={refundOpen ? 'Refund this order' : o.status === 'refunded' ? 'Already refunded' : 'Refund window closed (90 days after capture)'}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-red-200 rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer disabled:cursor-not-allowed transition-colors"
                      >
                        Refund
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {infoOrder && <OrderInfoModal order={infoOrder} onClose={() => setInfoOrder(null)} />}

      {refundTarget && (
        <ConfirmModal
          title={`Refund ${fmtCents(refundTarget.amount_cents)}?`}
          body={refundTarget.type === 'premium'
            ? `This refunds the premium payment from ${refundTarget.username} in full and revokes their premium access.`
            : `This refunds the storage purchase from ${refundTarget.username} in full and removes the purchased ${fmtCapacity(refundTarget.bytes_added ?? 0)} from their quota.`}
          confirmLabel={refundMutation.isPending ? 'Refunding…' : 'Issue refund'}
          disabled={refundMutation.isPending}
          onConfirm={() => refundMutation.mutate(refundTarget)}
          onCancel={() => setRefundTarget(null)}
        />
      )}

      {revertTarget && (
        <ConfirmModal
          title="Revert allocation?"
          body={(revertTarget.type === 'premium'
            ? `This revokes the premium access ${revertTarget.username} got from this sandbox payment.`
            : `This removes the ${fmtCapacity(revertTarget.bytes_added ?? 0)} this sandbox order added to ${revertTarget.username}'s quota.`)
            + ' No PayPal refund is issued — this is a sandbox test order, so nothing needs to be sent back.'}
          confirmLabel={revertMutation.isPending ? 'Reverting…' : 'Revert allocation'}
          disabled={revertMutation.isPending}
          onConfirm={() => revertMutation.mutate(revertTarget)}
          onCancel={() => setRevertTarget(null)}
        />
      )}
    </div>
  )
}

function OrderInfoModal({ order, onClose }: { order: AdminOrder; onClose: () => void }) {
  return (
    <ModalShell onClose={onClose} title="Order details">
      <div className="flex flex-col divide-y divide-gray-100 text-sm">
        <InfoRow label="Type" value={order.type === 'premium' ? 'Premium subscription' : 'Additional storage purchase'} />
        <InfoRow label="User" value={order.username} />
        <InfoRow label="Status" value={order.status} />
        <InfoRow label="Environment" value={order.environment === 'sandbox' ? 'Sandbox (test)' : 'Live'} />
        <InfoRow label="Amount" value={`${fmtCents(order.amount_cents)} ${order.currency}`} />
        <InfoRow label="Method" value={METHOD_LABELS[order.payment_method] ?? order.payment_method} />
        <InfoRow label="Reference" value={order.reference} mono />
        <InfoRow label="Invoice #" value={order.invoice_number} mono />
        <InfoRow label="Created" value={new Date(order.created_at).toLocaleString()} />
        <InfoRow label="Captured" value={order.captured_at ? new Date(order.captured_at).toLocaleString() : '—'} />
        {order.refund_id && <InfoRow label="Refund" value={`${order.refund_id} (${fmtDate(order.refunded_at)})`} mono />}
        {order.allocation_reverted_at && <InfoRow label="Allocation reverted" value={fmtDate(order.allocation_reverted_at)} />}
        {order.type === 'storage' && (
          <>
            <InfoRow label="Plan" value={order.plan_id ?? '—'} />
            <InfoRow label="Storage" value={`${fmtCapacity(order.bytes_added ?? 0)} · ${order.storage_type === 'nvme' ? 'Fast (NVMe)' : 'Standard (HDD)'}`} />
            <InfoRow label="Server" value={order.server_name || '—'} />
          </>
        )}
        {order.type === 'premium' && (
          <InfoRow label="Grants" value="Lifetime premium — SFS API + per-directory API keys" />
        )}
      </div>
    </ModalShell>
  )
}

// ── Expansion / custom requests tabs ──────────────────────────────────────────

const REQUEST_STATUS_COLORS: Record<string, string> = {
  opened:       'bg-blue-100 text-blue-700',
  invoice_sent: 'bg-cyan-100 text-cyan-700',
  accepted:     'bg-indigo-100 text-indigo-700',
  approved:     'bg-violet-100 text-violet-700',
  expanded:     'bg-purple-100 text-purple-700',
  completed:    'bg-green-100 text-green-700',
  expired:      'bg-gray-100 text-gray-500',
  refunded:     'bg-amber-100 text-amber-700',
  rejected:     'bg-red-100 text-red-600',
}

const TERMINAL_STATUSES = new Set(['completed', 'expired', 'refunded', 'rejected'])

// slaDeadline returns the deadline that currently applies to the request's stage.
function slaDeadline(r: ServerExpansionRequest): string | null {
  switch (r.status) {
    case 'opened':
    case 'accepted':
      return r.approval_due_at ?? r.expires_at
    case 'invoice_sent':
      return r.invoice_accept_due_at ?? null
    case 'approved':
      return r.expansion_due_at
    case 'expanded':
      return r.payment_due_at
        ? new Date(new Date(r.payment_due_at).getTime() + 30 * DAY_MS).toISOString()
        : null
    default:
      return null
  }
}

function slaDaysRemaining(r: ServerExpansionRequest): number | null {
  if (TERMINAL_STATUSES.has(r.status)) return null
  const deadline = slaDeadline(r)
  if (!deadline) return null
  return Math.ceil((new Date(deadline).getTime() - Date.now()) / DAY_MS)
}

function paymentStatus(r: ServerExpansionRequest): string {
  switch (r.status) {
    case 'completed': return 'Paid in full'
    case 'expanded': return 'Balance due'
    case 'refunded': return 'Deposit refunded'
    case 'rejected': return 'Nothing collected'
    case 'expired': return r.refund_id ? 'Deposit refunded' : 'Nothing collected / forfeited'
    default:
      return r.paypal_capture_id ? 'Deposit paid' : 'Unpaid'
  }
}

function RequestsTab({ custom }: { custom: boolean }) {
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('sla')
  const [page, setPage] = useState(1)
  const [invoiceTarget, setInvoiceTarget] = useState<ServerExpansionRequest | null>(null)
  const [cancelTarget, setCancelTarget] = useState<ServerExpansionRequest | null>(null)
  const [cancelReason, setCancelReason] = useState('')

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'expansion-requests', { custom, search, sort, page }],
    queryFn: () => listExpansionRequests({ is_custom: custom, search, sort, page, page_size: PAGE_SIZE }),
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'expansion-requests'] })

  const approveMutation = useMutation({
    mutationFn: (id: string) => approveExpansionRequest(id),
    onSuccess: () => { invalidate(); notify('success', 'Request approved — 14 business day expansion SLA started') },
    onError: (err) => notify('error', err instanceof ApiError ? err.message : 'Approve failed'),
  })

  const provisionMutation = useMutation({
    mutationFn: (id: string) => fulfillExpansionRequest(id),
    onSuccess: (res) => {
      invalidate()
      notify('success', res.remaining_cents > 0
        ? 'Quota provisioned — remaining balance requested from user'
        : 'Quota provisioned — request completed')
    },
    onError: (err) => notify('error', err instanceof ApiError ? err.message : 'Provision failed (does the server have capacity?)'),
  })

  const cancelMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => cancelExpansionRequest(id, reason),
    onSuccess: () => {
      setCancelTarget(null)
      setCancelReason('')
      invalidate()
      notify('success', 'Request cancelled')
    },
    onError: (err) => notify('error', err instanceof ApiError ? err.message : 'Cancel failed'),
  })

  const pageCount = data ? Math.ceil(data.total / PAGE_SIZE) : 1

  return (
    <div>
      <ListControls
        search={search} onSearch={(v) => { setSearch(v); setPage(1) }}
        sort={sort} onSort={(v) => { setSort(v); setPage(1) }}
        sortOptions={[
          { value: 'sla', label: 'Days till SLA expiry' },
          { value: 'deposit', label: 'Largest deposit first' },
          { value: 'created', label: 'Newest first' },
        ]}
        page={page} pageCount={pageCount} onPage={setPage}
      />

      {isLoading && <p className="text-sm text-gray-400">Loading…</p>}
      {error != null && <p className="text-sm text-red-500">Failed to load requests.</p>}

      {data && (
        <div className="border border-gray-200 rounded-xl overflow-x-auto bg-white">
          <table className="w-full text-sm border-collapse min-w-275">
            <thead>
              <tr className="bg-gray-50 text-left text-xs text-gray-500">
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Opened</th>
                <th className="px-3 py-2 font-medium">Capacity</th>
                <th className="px-3 py-2 font-medium">Deposit</th>
                <th className="px-3 py-2 font-medium">SLA days left</th>
                <th className="px-3 py-2 font-medium">Approved</th>
                <th className="px-3 py-2 font-medium">Server</th>
                <th className="px-3 py-2 font-medium">Payment</th>
                {custom && (
                  <>
                    <th className="px-3 py-2 font-medium">Invoice sent</th>
                    <th className="px-3 py-2 font-medium">Sent date</th>
                    <th className="px-3 py-2 font-medium">Accepted</th>
                  </>
                )}
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 && (
                <tr><td colSpan={custom ? 13 : 10} className="px-3 py-6 text-center text-gray-400">No requests found.</td></tr>
              )}
              {data.items.map((r) => {
                const days = slaDaysRemaining(r)
                const invoiceSent = !!r.invoice_number && r.invoice_status !== 'cancelled'
                const canApprove = custom ? r.status === 'accepted' : r.status === 'opened'
                const canProvision = r.status === 'approved' || (!custom && r.status === 'opened' && !!r.paypal_capture_id)
                const canInvoice = custom && (r.status === 'opened' || r.status === 'invoice_sent')
                const cancellable = !TERMINAL_STATUSES.has(r.status)
                return (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="px-3 py-2"><UserLink username={r.username} /></td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded whitespace-nowrap ${REQUEST_STATUS_COLORS[r.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {r.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-500">{fmtDate(r.created_at)}</td>
                    <td className="px-3 py-2 text-gray-700 whitespace-nowrap">
                      {fmtCapacity(r.bytes_requested)} {r.storage_type === 'nvme' ? 'Fast' : 'Std'}
                    </td>
                    <td className="px-3 py-2 text-gray-700">
                      {r.deposit_amount_cents > 0 ? fmtCents(r.deposit_amount_cents) : custom ? `est. ${fmtCents(Math.ceil(r.full_price_cents / 2))}` : '—'}
                    </td>
                    <td className="px-3 py-2">
                      {days === null ? <span className="text-gray-300">—</span> : (
                        <span className={`font-medium ${days < 0 ? 'text-red-600' : days <= 2 ? 'text-amber-600' : 'text-gray-700'}`}>
                          {days < 0 ? `${-days}d overdue` : `${days}d`}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">{r.approved_at ? <MdCheck className="text-green-500" /> : <MdClose className="text-gray-300" />}</td>
                    <td className="px-3 py-2 text-gray-600">{r.server_name}</td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{paymentStatus(r)}</td>
                    {custom && (
                      <>
                        <td className="px-3 py-2">{invoiceSent ? <MdCheck className="text-green-500" /> : <MdClose className="text-gray-300" />}</td>
                        <td className="px-3 py-2 text-gray-500">{invoiceSent ? fmtDate(r.invoice_sent_at) : '—'}</td>
                        <td className="px-3 py-2">{r.invoice_status === 'accepted' ? <MdCheck className="text-green-500" /> : <MdClose className="text-gray-300" />}</td>
                      </>
                    )}
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {canInvoice && (
                        <button
                          onClick={() => setInvoiceTarget(r)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-blue-200 rounded-lg text-blue-600 hover:bg-blue-50 cursor-pointer transition-colors mr-1.5"
                        >
                          <MdReceiptLong /> {r.status === 'invoice_sent' ? 'Re-invoice' : 'Invoice'}
                        </button>
                      )}
                      {canApprove && (
                        <button
                          onClick={() => approveMutation.mutate(r.id)}
                          disabled={approveMutation.isPending}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-green-200 rounded-lg text-green-600 hover:bg-green-50 disabled:opacity-50 cursor-pointer transition-colors mr-1.5"
                        >
                          <MdCheck /> Approve
                        </button>
                      )}
                      {canProvision && (
                        <button
                          onClick={() => provisionMutation.mutate(r.id)}
                          disabled={provisionMutation.isPending}
                          title="Provision the expanded quota (server must have the capacity)"
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-violet-200 rounded-lg text-violet-600 hover:bg-violet-50 disabled:opacity-50 cursor-pointer transition-colors mr-1.5"
                        >
                          <MdAdd /> Provision
                        </button>
                      )}
                      {cancellable && (
                        <button
                          onClick={() => setCancelTarget(r)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-red-200 rounded-lg text-red-600 hover:bg-red-50 cursor-pointer transition-colors"
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {invoiceTarget && (
        <InvoiceCreatorModal
          request={invoiceTarget}
          onClose={() => setInvoiceTarget(null)}
          onSent={() => { setInvoiceTarget(null); invalidate() }}
        />
      )}

      {cancelTarget && (
        <ModalShell onClose={() => setCancelTarget(null)} title="Cancel request">
          <p className="text-sm text-gray-600 m-0 mb-3">
            Cancel {cancelTarget.username}&rsquo;s {fmtCapacity(cancelTarget.bytes_requested)} request on{' '}
            {cancelTarget.server_name}?{' '}
            {cancelTarget.paypal_capture_id
              ? 'The deposit will be refunded in full.'
              : 'Nothing has been collected, so no refund is needed.'}
          </p>
          <textarea
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="Reason (sent to the user)"
            rows={3}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <div className="flex justify-end gap-2 mt-3">
            <button
              onClick={() => setCancelTarget(null)}
              className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 cursor-pointer"
            >
              Keep request
            </button>
            <button
              onClick={() => cancelMutation.mutate({ id: cancelTarget.id, reason: cancelReason.trim() })}
              disabled={!cancelReason.trim() || cancelMutation.isPending}
              className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium disabled:opacity-50 cursor-pointer"
            >
              {cancelMutation.isPending ? 'Cancelling…' : 'Cancel request'}
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  )
}

// ── Invoice creator ───────────────────────────────────────────────────────────

interface DraftLineItem {
  description: string
  amount: string // dollars, free text
}

function InvoiceCreatorModal({
  request, onClose, onSent,
}: {
  request: ServerExpansionRequest
  onClose: () => void
  onSent: () => void
}) {
  const { notify } = useNotification()
  const [lineItems, setLineItems] = useState<DraftLineItem[]>([
    {
      description: `${fmtCapacity(request.bytes_requested)} ${request.storage_type === 'nvme' ? 'Fast (NVMe)' : 'Standard (HDD)'} storage on ${request.server_name}`,
      amount: (request.full_price_cents / 100).toFixed(2),
    },
  ])
  const [deposit, setDeposit] = useState('')
  const [disclosures, setDisclosures] = useState(
    'Capacity is provisioned within 14 business days of approval. The remaining balance is due once provisioned; unpaid balances 30 days past due result in the allocation being reverted and the deposit retained.',
  )
  const [notes, setNotes] = useState('')
  const [includeLink, setIncludeLink] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const parsedItems = lineItems.map((li) => ({
    description: li.description,
    amount_cents: Math.round((parseFloat(li.amount) || 0) * 100),
  }))
  const totalCents = parsedItems.reduce((sum, li) => sum + li.amount_cents, 0)
  const depositCents = Math.round((parseFloat(deposit) || 0) * 100)
  const valid = parsedItems.length > 0
    && parsedItems.every((li) => li.description.trim() && li.amount_cents > 0)
    && depositCents >= 0 && depositCents <= totalCents

  const sendMutation = useMutation({
    mutationFn: () => {
      const payload: AdminInvoicePayload = {
        line_items: parsedItems,
        deposit_cents: depositCents,
        disclosures,
        notes,
        include_review_link: includeLink,
      }
      return createExpansionInvoice(request.id, payload)
    },
    onSuccess: (inv) => {
      notify('success', `Invoice ${inv.invoice_number} sent to ${request.user_email}`)
      onSent()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to send invoice'),
  })

  const previewInvoice = {
    invoice_number: 'INV-PREVIEW',
    line_items: parsedItems,
    total_cents: totalCents,
    deposit_cents: depositCents,
    disclosures,
    notes,
    sent_at: new Date().toISOString(),
    accept_due_at: new Date(Date.now() + 20 * DAY_MS).toISOString(),
  }

  return (
    <div onClick={onClose} className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-[64rem] max-w-[96vw] max-h-[92vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <h3 className="text-base font-semibold text-gray-900 m-0">
            Create invoice — {request.username} · {fmtCapacity(request.bytes_requested)} {request.storage_type === 'nvme' ? 'Fast' : 'Standard'}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0">
            <MdClose className="text-xl" />
          </button>
        </div>

        <div className="flex flex-col lg:flex-row gap-6 overflow-y-auto px-6 py-5">
          {/* Editor */}
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            <div>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-0 mb-2">Line items</h4>
              <div className="flex flex-col gap-2">
                {lineItems.map((li, i) => (
                  <div key={i} className="flex gap-2 items-start">
                    <input
                      type="text"
                      value={li.description}
                      onChange={(e) => setLineItems((prev) => prev.map((x, j) => j === i ? { ...x, description: e.target.value } : x))}
                      placeholder="Description"
                      className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <div className="relative">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={li.amount}
                        onChange={(e) => setLineItems((prev) => prev.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))}
                        className="w-28 border border-gray-200 rounded-lg pl-6 pr-2 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>
                    <button
                      onClick={() => setLineItems((prev) => prev.filter((_, j) => j !== i))}
                      disabled={lineItems.length <= 1}
                      title="Remove line item"
                      className="mt-2 text-gray-300 hover:text-red-500 disabled:opacity-30 cursor-pointer bg-transparent border-0 p-0"
                    >
                      <MdClose />
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => setLineItems((prev) => [...prev, { description: '', amount: '' }])}
                  className="self-start inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 bg-transparent border-0 p-0 cursor-pointer"
                >
                  <MdAdd /> Add line item
                </button>
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-0 mb-2">
                Deposit due on acceptance <span className="normal-case font-normal">(0 for none · total {fmtCents(totalCents)})</span>
              </h4>
              <div className="relative w-40">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={deposit}
                  onChange={(e) => setDeposit(e.target.value)}
                  placeholder="0.00"
                  className="w-full border border-gray-200 rounded-lg pl-6 pr-2 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              {depositCents > totalCents && (
                <p className="text-xs text-red-500 m-0 mt-1">Deposit cannot exceed the invoice total.</p>
              )}
            </div>

            <div>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-0 mb-2">Notes</h4>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Shown on the invoice above the disclosures"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-0 mb-2">Disclosures</h4>
              <textarea
                value={disclosures}
                onChange={(e) => setDisclosures(e.target.value)}
                rows={3}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={includeLink}
                onChange={(e) => setIncludeLink(e.target.checked)}
                className="cursor-pointer mt-0.5"
              />
              <span>
                Include a link back to the website to review &amp; approve this invoice
                {depositCents > 0 && <> (approval requires paying the {fmtCents(depositCents)} deposit)</>}
              </span>
            </label>

            <p className="text-xs text-gray-400 m-0">
              The user has <span className="font-semibold">14 business days</span> to accept
              {depositCents > 0 ? ' and pay the deposit' : ''}; the request expires otherwise.
            </p>

            {error && <p className="text-xs text-red-500 m-0">{error}</p>}

            <div className="flex justify-end gap-2 mt-auto pt-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 cursor-pointer"
              >
                Discard
              </button>
              <button
                onClick={() => sendMutation.mutate()}
                disabled={!valid || sendMutation.isPending}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50 cursor-pointer"
              >
                {sendMutation.isPending ? 'Sending…' : `Send invoice (${fmtCents(totalCents)})`}
              </button>
            </div>
          </div>

          {/* PDF-style preview */}
          <div className="flex-1 min-w-0 bg-gray-100 rounded-xl p-4 overflow-y-auto">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider m-0 mb-2">Preview</p>
            <InvoiceDocument
              invoice={previewInvoice}
              request={{
                server_name: request.server_name,
                storage_type: request.storage_type,
                bytes_requested: request.bytes_requested,
                username: request.username,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Small shared modals ───────────────────────────────────────────────────────

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div onClick={onClose} className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-120 max-w-[92vw] max-h-[85vh] overflow-y-auto p-6"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900 m-0">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0">
            <MdClose className="text-xl" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function ConfirmModal({
  title, body, confirmLabel, disabled, onConfirm, onCancel,
}: {
  title: string
  body: string
  confirmLabel: string
  disabled?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <ModalShell title={title} onClose={onCancel}>
      <p className="text-sm text-gray-600 m-0 mb-4">{body}</p>
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 cursor-pointer"
        >
          Keep
        </button>
        <button
          onClick={onConfirm}
          disabled={disabled}
          className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium disabled:opacity-50 cursor-pointer"
        >
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  )
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between py-2 gap-4">
      <span className="text-gray-500 shrink-0">{label}</span>
      <span className={`text-gray-900 text-right break-all ${mono ? 'font-mono text-xs mt-0.5' : ''}`}>{value}</span>
    </div>
  )
}
