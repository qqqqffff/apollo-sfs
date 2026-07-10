import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MdBolt, MdReceiptLong, MdRocketLaunch, MdStorage } from 'react-icons/md'
import {
  formatCents,
  listMyExpansionRequests,
  listMyOrders,
  type ExpansionRequest,
  type UserOrder,
} from '../../api/billing'
import { listMySubscriptions, type PremiumSubscriptionOrder } from '../../api/payments'
import { revertAdminOrderAllocation } from '../../api/admin'
import { ApiError } from '../../api/client'
import { useAuth } from '../../auth'
import { useNotification } from '../../context/NotificationContext'
import { PayRemainingModal } from '../../components/PayRemainingModal'

type Tab = 'storage' | 'requests' | 'premium'

export const Route = createFileRoute('/_auth/client/orders')({
  // pay: request id whose remaining-balance form should open on load
  // (deep-linked from the payment-required notification).
  // tab: which section is active — mirrors the admin Orders page pattern.
  validateSearch: (search: Record<string, unknown>): { pay?: string; tab?: Tab } => ({
    pay: typeof search.pay === 'string' ? search.pay : undefined,
    tab: search.tab === 'premium' ? 'premium' : search.tab === 'requests' ? 'requests' : search.tab === 'storage' ? 'storage' : undefined,
  }),
  component: RouteComponent,
})

const TIB = 1024 ** 4
const DAY_MS = 24 * 60 * 60 * 1000
// Mirrors allocationRevertDays in api/routes/orders/handler.go — the
// background loop that auto-reverts a captured sandbox order's granted
// quota/premium 7 calendar days after capture. Only applies to the legacy
// one-time premium/storage order flow, not subscriptions.
const ALLOCATION_REVERT_DAYS = 7

// cleanupDueAt returns when a captured sandbox order's allocation auto-reverts.
function cleanupDueAt(capturedAt: string): Date {
  return new Date(new Date(capturedAt).getTime() + ALLOCATION_REVERT_DAYS * DAY_MS)
}

function fmtCountdown(dueAt: Date): string {
  const msLeft = dueAt.getTime() - Date.now()
  if (msLeft <= 0) return 'cleanup pending'
  const days = Math.floor(msLeft / DAY_MS)
  const hours = Math.floor((msLeft % DAY_MS) / (60 * 60 * 1000))
  const minutes = Math.floor((msLeft % (60 * 60 * 1000)) / (60 * 1000))
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function formatCapacity(bytes: number): string {
  if (bytes >= 1024 * TIB) return `${(bytes / (1024 * TIB)).toFixed(1).replace(/\.0$/, '')} PB`
  if (bytes >= TIB) return `${(bytes / TIB).toFixed(1).replace(/\.0$/, '')} TB`
  return `${Math.round(bytes / 1024 ** 3)} GB`
}

const METHOD_LABELS: Record<string, string> = {
  paypal: 'PayPal',
  card: 'Card',
  hosted_card: 'Card',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
  invoice: 'Invoice',
}

const PLAN_LABELS: Record<string, string> = {
  monthly: 'Monthly',
  annual: 'Annual',
}

const SUBSCRIPTION_STATUS_META: Record<string, { label: string; className: string }> = {
  approval_pending: { label: 'awaiting approval', className: 'text-amber-600' },
  active: { label: 'active', className: 'text-green-600' },
  suspended: { label: 'suspended', className: 'text-amber-600' },
  cancelled: { label: 'cancelled', className: 'text-gray-400' },
  expired: { label: 'expired', className: 'text-gray-400' },
}

// Group buckets in display order.
type Group = 'action' | 'pending' | 'progress' | 'completed' | 'closed'

const GROUP_META: Record<Group, { title: string; hint: string }> = {
  action:    { title: 'Pending your action', hint: 'These need something from you to move forward.' },
  pending:   { title: 'Pending approval',    hint: 'Waiting on our team to review or approve.' },
  progress:  { title: 'In progress',         hint: 'Approved — capacity expansion under way.' },
  completed: { title: 'Completed',           hint: '' },
  closed:    { title: 'Closed',              hint: 'Expired, refunded or rejected requests.' },
}

function requestGroup(r: ExpansionRequest): Group {
  switch (r.status) {
    case 'invoice_sent':
    case 'expanded':
      return 'action'
    case 'opened':
    case 'accepted':
      return 'pending'
    case 'approved':
      return 'progress'
    case 'completed':
      return 'completed'
    default:
      return 'closed'
  }
}

// Per-status badge shown on each request row (distinct from the broader
// Group section it sorts into — several statuses share a Group, e.g.
// 'invoice_sent' and 'expanded' both land in "action", so the row itself
// still needs to say which one it actually is).
const REQUEST_STATUS_META: Record<ExpansionRequest['status'], { label: string; className: string }> = {
  opened:       { label: 'Awaiting review',    className: 'bg-amber-50 text-amber-700' },
  invoice_sent: { label: 'Invoice sent',       className: 'bg-blue-50 text-blue-700' },
  accepted:     { label: 'Invoice accepted',   className: 'bg-blue-50 text-blue-700' },
  approved:     { label: 'Approved',           className: 'bg-blue-50 text-blue-700' },
  expanded:     { label: 'Balance due',        className: 'bg-purple-50 text-purple-700' },
  completed:    { label: 'Completed',          className: 'bg-green-50 text-green-700' },
  expired:      { label: 'Expired',            className: 'bg-gray-100 text-gray-500' },
  refunded:     { label: 'Refunded',           className: 'bg-gray-100 text-gray-500' },
  rejected:     { label: 'Rejected',           className: 'bg-red-50 text-red-600' },
}

// PremiumRow normalizes the two premium data sources — legacy one-time
// payments rows (pre-dating the subscription migration) and the new
// premium_subscriptions rows — into one shape so both render identically,
// with "premium until" / "next payment" filled in appropriately for each.
interface PremiumRow {
  key: string
  title: string
  dateMs: number
  dateLabel: string
  paymentMethod: string
  reference: string
  amountCents: number
  environment: 'sandbox' | 'live'
  statusLabel: string
  statusClassName: string
  premiumUntilLabel: string
  nextPaymentLabel: string
  // Present only for legacy one-time entries — backs the admin sandbox
  // revert-allocation action, which subscriptions don't have (cancel via the
  // profile card instead).
  legacyOrder?: UserOrder
}

function buildPremiumRows(orderList: UserOrder[], subscriptions: PremiumSubscriptionOrder[]): PremiumRow[] {
  const legacyRows: PremiumRow[] = orderList
    .filter((o) => o.type === 'premium')
    .map((o) => {
      const dateMs = new Date(o.captured_at ?? o.created_at).getTime()
      return {
        key: `legacy-${o.id}`,
        title: 'Premium (lifetime purchase)',
        dateMs,
        dateLabel: new Date(dateMs).toLocaleDateString(),
        paymentMethod: METHOD_LABELS[o.payment_method] ?? o.payment_method,
        reference: o.invoice_number,
        amountCents: o.amount_cents,
        environment: o.environment,
        statusLabel: o.status,
        statusClassName: o.status === 'captured' ? 'text-green-600' : o.status === 'refunded' ? 'text-gray-400' : 'text-amber-600',
        premiumUntilLabel: 'Lifetime',
        nextPaymentLabel: '—',
        legacyOrder: o,
      }
    })

  const subscriptionRows: PremiumRow[] = subscriptions.map((s) => {
    const dateMs = new Date(s.created_at).getTime()
    const periodEndLabel = s.current_period_end ? new Date(s.current_period_end).toLocaleDateString() : '—'
    const meta = SUBSCRIPTION_STATUS_META[s.status] ?? { label: s.status, className: 'text-gray-400' }
    return {
      key: `sub-${s.id}`,
      title: `${PLAN_LABELS[s.plan] ?? s.plan} Premium subscription`,
      dateMs,
      dateLabel: new Date(dateMs).toLocaleDateString(),
      paymentMethod: METHOD_LABELS[s.payment_method] ?? s.payment_method,
      reference: s.reference,
      amountCents: s.amount_cents,
      environment: s.environment,
      statusLabel: meta.label,
      statusClassName: meta.className,
      premiumUntilLabel: periodEndLabel,
      nextPaymentLabel: s.status === 'active' ? periodEndLabel : '—',
    }
  })

  return [...legacyRows, ...subscriptionRows].sort((a, b) => b.dateMs - a.dateMs)
}

function RouteComponent() {
  const { pay, tab } = Route.useSearch()
  const { admin } = useAuth()
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const [activeTab, setActiveTab] = useState<Tab>(tab ?? 'storage')

  const { data: requests = [] } = useQuery({
    queryKey: ['billing', 'expansion-requests'],
    queryFn: listMyExpansionRequests,
  })
  const { data: orders = [] } = useQuery({
    queryKey: ['billing', 'orders', 'mine'],
    queryFn: listMyOrders,
  })
  const { data: subscriptions = [] } = useQuery({
    queryKey: ['payments', 'subscriptions', 'mine'],
    queryFn: listMySubscriptions,
  })

  const [payTarget, setPayTarget] = useState<ExpansionRequest | null>(null)
  const [autoOpened, setAutoOpened] = useState(false)

  // Admin-only: undoes a sandbox test order's local quota/premium grant, no
  // PayPal call. Only admins can create sandbox orders (session toggle on the
  // Profile page), so this button only ever shows on an admin's own orders.
  // Subscriptions have no equivalent revert action — cancel via the profile
  // card instead.
  const revertMutation = useMutation({
    mutationFn: (o: UserOrder) => revertAdminOrderAllocation(o.type, o.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['billing', 'orders', 'mine'] })
      // Mirrors StorageUpgradeModal's post-purchase invalidation — reverting
      // a storage/premium allocation changes the same 'me' fields a purchase
      // does, so the nav bar, profile, and upload-capacity checks must not
      // keep showing the pre-revert quota/premium state.
      queryClient.invalidateQueries({ queryKey: ['me'] })
      queryClient.invalidateQueries({ queryKey: ['storage'] })
      notify('success', 'Allocation reverted')
    },
    onError: (err) => notify('error', err instanceof ApiError ? err.message : 'Revert failed'),
  })

  // Deep link: ?pay=<request id> opens the balance form once data arrives.
  const reqList = Array.isArray(requests) ? requests : []
  const orderList = Array.isArray(orders) ? orders : []
  const subscriptionList = Array.isArray(subscriptions) ? subscriptions : []
  if (pay && !autoOpened && reqList.length > 0) {
    const target = reqList.find((r) => r.id === pay && r.status === 'expanded')
    if (target) {
      setPayTarget(target)
      setAutoOpened(true)
    }
  }

  const groups: Group[] = ['action', 'pending', 'progress', 'completed', 'closed']
  const grouped = new Map<Group, ExpansionRequest[]>()
  for (const r of reqList) {
    const g = requestGroup(r)
    grouped.set(g, [...(grouped.get(g) ?? []), r])
  }

  const storageOrders = orderList.filter((o) => o.type === 'storage')
  const premiumRows = buildPremiumRows(orderList, subscriptionList)

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 m-0">My orders</h2>
        <Link
          to="/client/profile"
          className="text-xs text-blue-600 hover:text-blue-700 no-underline hover:underline"
        >
          Back to profile
        </Link>
      </div>

      <div className="flex gap-1 border-b border-gray-200">
        {([
          { key: 'storage', label: 'Storage' },
          { key: 'requests', label: 'Requests' },
          { key: 'premium', label: 'Premium' },
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

      {activeTab === 'requests' && (
        <>
          {reqList.length === 0 && (
            <p className="text-sm text-gray-400">
              No expansion or custom capacity requests yet. Requests you submit from the Add storage
              modal will appear here.
            </p>
          )}

          {/* Expansion / custom requests grouped by state */}
          {groups.map((g) => {
            const items = grouped.get(g)
            if (!items || items.length === 0) return null
            const meta = GROUP_META[g]
            return (
              <div key={g}>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-0 mb-1">{meta.title}</h3>
                {meta.hint && <p className="text-xs text-gray-400 mt-0 mb-2">{meta.hint}</p>}
                <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
                  {items.map((r) => {
                    const statusMeta = REQUEST_STATUS_META[r.status] ?? { label: r.status, className: 'bg-gray-100 text-gray-500' }
                    return (
                      <div key={r.id} className="px-4 py-3 flex items-center gap-3">
                        <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                          r.storage_type === 'nvme' ? 'bg-blue-50' : 'bg-amber-50'
                        }`}>
                          {r.storage_type === 'nvme'
                            ? <MdBolt className="text-blue-600 text-sm" />
                            : <MdStorage className="text-amber-500 text-sm" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-medium text-gray-800 m-0">
                              {formatCapacity(r.bytes_requested)} {r.storage_type === 'nvme' ? 'Fast' : 'Standard'} expansion
                              {r.is_custom ? ' (custom)' : ''} — {r.server_name}
                            </p>
                            <span className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded ${statusMeta.className}`}>
                              {statusMeta.label}
                            </span>
                          </div>
                          <p className="text-xs text-gray-400 m-0 mt-0.5">
                            requested {new Date(r.created_at).toLocaleDateString()}
                            {r.status === 'expanded' && (
                              <> · balance {formatCents(r.full_price_cents - r.deposit_amount_cents)}</>
                            )}
                          </p>
                        </div>
                        <div className="shrink-0 flex flex-col items-end gap-1.5">
                          {r.status === 'expanded' && r.full_price_cents > r.deposit_amount_cents && (
                            <button
                              onClick={() => setPayTarget(r)}
                              className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
                            >
                              Pay balance
                            </button>
                          )}
                          {r.status === 'invoice_sent' && (
                            r.invoice_review_token ? (
                              <Link
                                to={`/invoice/${r.invoice_review_token}` as never}
                                className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium no-underline text-center transition-colors"
                              >
                                Review invoice
                              </Link>
                            ) : (
                              <span className="text-xs text-amber-600 text-right">Check your email for the invoice</span>
                            )
                          )}
                          {r.invoice_review_token && r.status !== 'invoice_sent' && (
                            <Link
                              to={`/invoice/${r.invoice_review_token}` as never}
                              className="text-xs text-blue-600 hover:text-blue-700 no-underline hover:underline"
                            >
                              View invoice
                            </Link>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </>
      )}

      {activeTab === 'storage' && (
        <>
          {storageOrders.length === 0 && (
            <p className="text-sm text-gray-400">No storage purchases yet. Add storage from your profile page to see it here.</p>
          )}

          {/* Storage payment history */}
          {storageOrders.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-0 mb-2">Payments</h3>
              <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
                {storageOrders.map((o: UserOrder) => (
                  <div key={`${o.type}-${o.id}`} className="px-4 py-3 flex items-center gap-3">
                    <div className="w-7 h-7 rounded-lg bg-gray-50 flex items-center justify-center shrink-0">
                      <MdReceiptLong className="text-gray-500 text-sm" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 m-0">
                        {formatCapacity(o.bytes_added ?? 0)} {o.storage_type === 'nvme' ? 'Fast' : 'Standard'} storage{o.server_name ? ` — ${o.server_name}` : ''}
                      </p>
                      <p className="text-xs text-gray-400 m-0 mt-0.5">
                        {new Date(o.captured_at ?? o.created_at).toLocaleDateString()} · {METHOD_LABELS[o.payment_method] ?? o.payment_method} · {o.invoice_number}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold text-gray-800 m-0">
                        {formatCents(o.amount_cents)}
                        {o.environment === 'sandbox' && (
                          <span
                            title="Made while your sandbox-payments toggle was on — not a real charge"
                            className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-purple-100 text-purple-700 align-middle"
                          >
                            Sandbox
                          </span>
                        )}
                      </p>
                      <p className={`text-[10px] font-semibold uppercase tracking-wider m-0 mt-0.5 ${
                        o.status === 'captured' ? 'text-green-600' : o.status === 'refunded' ? 'text-gray-400' : 'text-amber-600'
                      }`}>
                        {o.status}
                      </p>
                      {o.environment === 'sandbox' && o.status === 'captured' && !o.allocation_reverted_at && o.captured_at && (
                        <p
                          title={`Auto-reverts ${cleanupDueAt(o.captured_at).toLocaleString()} unless reverted sooner`}
                          className="text-[10px] text-purple-500 m-0 mt-1"
                        >
                          Auto-reverts in {fmtCountdown(cleanupDueAt(o.captured_at))}
                        </p>
                      )}
                      {admin && o.environment === 'sandbox' && o.status === 'captured' && (
                        o.allocation_reverted_at ? (
                          <p className="text-[10px] text-gray-400 m-0 mt-1">Allocation reverted</p>
                        ) : (
                          <button
                            onClick={() => revertMutation.mutate(o)}
                            disabled={revertMutation.isPending}
                            title="Revert the granted quota/premium — no PayPal refund"
                            className="mt-1 px-2 py-0.5 text-[10px] border border-purple-200 rounded-lg text-purple-600 hover:bg-purple-50 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed transition-colors"
                          >
                            Revert allocation
                          </button>
                        )
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {activeTab === 'premium' && (
        <>
          {premiumRows.length === 0 && (
            <p className="text-sm text-gray-400">
              No premium purchases yet. Subscribe from your profile page to see it here.
            </p>
          )}

          {premiumRows.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-0 mb-2">Premium subscriptions</h3>
              <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
                {premiumRows.map((row) => (
                  <div key={row.key} className="px-4 py-3 flex items-center gap-3">
                    <div className="w-7 h-7 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
                      <MdRocketLaunch className="text-amber-500 text-sm" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 m-0">{row.title}</p>
                      <p className="text-xs text-gray-400 m-0 mt-0.5">
                        {row.dateLabel} · {row.paymentMethod} · {row.reference}
                      </p>
                      <p className="text-xs text-gray-400 m-0 mt-0.5">
                        Premium until: {row.premiumUntilLabel} · Next payment: {row.nextPaymentLabel}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold text-gray-800 m-0">
                        {formatCents(row.amountCents)}
                        {row.environment === 'sandbox' && (
                          <span
                            title="Made while your sandbox-payments toggle was on — not a real charge"
                            className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-purple-100 text-purple-700 align-middle"
                          >
                            Sandbox
                          </span>
                        )}
                      </p>
                      <p className={`text-[10px] font-semibold uppercase tracking-wider m-0 mt-0.5 ${row.statusClassName}`}>
                        {row.statusLabel}
                      </p>
                      {row.legacyOrder && row.environment === 'sandbox' && row.legacyOrder.status === 'captured' && !row.legacyOrder.allocation_reverted_at && row.legacyOrder.captured_at && (
                        <p
                          title={`Auto-reverts ${cleanupDueAt(row.legacyOrder.captured_at).toLocaleString()} unless reverted sooner`}
                          className="text-[10px] text-purple-500 m-0 mt-1"
                        >
                          Auto-reverts in {fmtCountdown(cleanupDueAt(row.legacyOrder.captured_at))}
                        </p>
                      )}
                      {admin && row.legacyOrder && row.environment === 'sandbox' && row.legacyOrder.status === 'captured' && (
                        row.legacyOrder.allocation_reverted_at ? (
                          <p className="text-[10px] text-gray-400 m-0 mt-1">Allocation reverted</p>
                        ) : (
                          <button
                            onClick={() => revertMutation.mutate(row.legacyOrder as UserOrder)}
                            disabled={revertMutation.isPending}
                            title="Revert the granted quota/premium — no PayPal refund"
                            className="mt-1 px-2 py-0.5 text-[10px] border border-purple-200 rounded-lg text-purple-600 hover:bg-purple-50 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed transition-colors"
                          >
                            Revert allocation
                          </button>
                        )
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {payTarget && <PayRemainingModal request={payTarget} onClose={() => setPayTarget(null)} />}
    </div>
  )
}
