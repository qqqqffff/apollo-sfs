import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MdBolt, MdReceiptLong, MdStorage } from 'react-icons/md'
import {
  formatCents,
  listMyExpansionRequests,
  listMyOrders,
  type ExpansionRequest,
  type UserOrder,
} from '../../api/billing'
import { PayRemainingModal } from '../../components/PayRemainingModal'

export const Route = createFileRoute('/_auth/client/orders')({
  // pay: request id whose remaining-balance form should open on load
  // (deep-linked from the payment-required notification).
  validateSearch: (search: Record<string, unknown>): { pay?: string } => ({
    pay: typeof search.pay === 'string' ? search.pay : undefined,
  }),
  component: RouteComponent,
})

const TIB = 1024 ** 4

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

const REQUEST_STATUS_LABELS: Record<ExpansionRequest['status'], string> = {
  opened: 'Awaiting review',
  invoice_sent: 'Invoice awaiting your review',
  accepted: 'Invoice accepted — awaiting approval',
  approved: 'Approved — expansion in progress',
  expanded: 'Capacity provisioned — balance due',
  completed: 'Completed',
  expired: 'Expired',
  refunded: 'Refunded',
  rejected: 'Rejected',
}

function RouteComponent() {
  const { pay } = Route.useSearch()
  const { data: requests = [] } = useQuery({
    queryKey: ['billing', 'expansion-requests'],
    queryFn: listMyExpansionRequests,
  })
  const { data: orders = [] } = useQuery({
    queryKey: ['billing', 'orders', 'mine'],
    queryFn: listMyOrders,
  })

  const [payTarget, setPayTarget] = useState<ExpansionRequest | null>(null)
  const [autoOpened, setAutoOpened] = useState(false)

  // Deep link: ?pay=<request id> opens the balance form once data arrives.
  const reqList = Array.isArray(requests) ? requests : []
  const orderList = Array.isArray(orders) ? orders : []
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

      {reqList.length === 0 && orderList.length === 0 && (
        <p className="text-sm text-gray-400">No orders yet. Purchases and expansion requests will appear here.</p>
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
              {items.map((r) => (
                <div key={r.id} className="px-4 py-3 flex items-center gap-3">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                    r.storage_type === 'nvme' ? 'bg-blue-50' : 'bg-amber-50'
                  }`}>
                    {r.storage_type === 'nvme'
                      ? <MdBolt className="text-blue-600 text-sm" />
                      : <MdStorage className="text-amber-500 text-sm" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 m-0">
                      {formatCapacity(r.bytes_requested)} {r.storage_type === 'nvme' ? 'Fast' : 'Standard'} expansion
                      {r.is_custom ? ' (custom)' : ''} — {r.server_name}
                    </p>
                    <p className="text-xs text-gray-400 m-0 mt-0.5">
                      {REQUEST_STATUS_LABELS[r.status] ?? r.status} · requested {new Date(r.created_at).toLocaleDateString()}
                      {r.status === 'expanded' && (
                        <> · balance {formatCents(r.full_price_cents - r.deposit_amount_cents)}</>
                      )}
                    </p>
                  </div>
                  {r.status === 'expanded' && r.full_price_cents > r.deposit_amount_cents && (
                    <button
                      onClick={() => setPayTarget(r)}
                      className="shrink-0 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
                    >
                      Pay balance
                    </button>
                  )}
                  {r.status === 'invoice_sent' && (
                    <span className="shrink-0 text-xs text-amber-600">Check your email for the invoice</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {/* Payment history */}
      {orderList.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-0 mb-2">Payments</h3>
          <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
            {orderList.map((o: UserOrder) => (
              <div key={`${o.type}-${o.id}`} className="px-4 py-3 flex items-center gap-3">
                <div className="w-7 h-7 rounded-lg bg-gray-50 flex items-center justify-center shrink-0">
                  <MdReceiptLong className="text-gray-500 text-sm" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 m-0">
                    {o.type === 'premium'
                      ? 'Premium subscription'
                      : `${formatCapacity(o.bytes_added ?? 0)} ${o.storage_type === 'nvme' ? 'Fast' : 'Standard'} storage${o.server_name ? ` — ${o.server_name}` : ''}`}
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
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {payTarget && <PayRemainingModal request={payTarget} onClose={() => setPayTarget(null)} />}
    </div>
  )
}
