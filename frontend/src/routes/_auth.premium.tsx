import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { MdCheck, MdRocketLaunch, MdCreditCard, MdPhoneIphone } from 'react-icons/md'
import { capturePaymentOrder, createPaymentOrder, type PaymentMethod } from '../api/payments'
import { meQueryOptions } from '../api/me'

interface Search {
  status?: 'approved' | 'cancelled'
  token?: string  // PayPal redirect: order_id is in the `token` query param
  PayerID?: string
}

export const Route = createFileRoute('/_auth/premium')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    status: search.status === 'approved' || search.status === 'cancelled' ? search.status : undefined,
    token: typeof search.token === 'string' ? search.token : undefined,
    PayerID: typeof search.PayerID === 'string' ? search.PayerID : undefined,
  }),
  component: RouteComponent,
})

const FEATURES = [
  'SFS S3-compatible API for programmatic access',
  'Per-directory API keys with read / write / delete / list scopes',
  'Share folder URLs from the file browser',
  'Same encryption + storage allocation as the web UI',
  'Lifetime access — one-time payment',
]

function RouteComponent() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const search = useSearch({ from: '/_auth/premium' })
  const { data: user } = useQuery(meQueryOptions)
  const [error, setError] = useState<string | null>(null)
  const [method, setMethod] = useState<PaymentMethod | null>(null)

  const createOrder = useMutation({
    mutationFn: (m: PaymentMethod) => createPaymentOrder(m),
    onSuccess: (res) => {
      // Redirect the browser to PayPal's approval URL; PayPal redirects back
      // here with ?status=approved&token=<order_id> when complete.
      window.location.href = res.approve_url
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to create order'),
  })

  const capture = useMutation({
    mutationFn: (orderID: string) => capturePaymentOrder(orderID),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      navigate({ to: '/settings/api-keys' as never })
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Capture failed'),
  })

  // PayPal redirected back with approval → run capture.
  if (search.status === 'approved' && search.token && !capture.isSuccess && !capture.isPending) {
    capture.mutate(search.token)
  }

  if (!user) return <p className="text-sm text-gray-500">Loading…</p>

  if (user.is_premium || user.is_admin) {
    return (
      <div className="max-w-xl mx-auto text-center py-12">
        <MdCheck className="text-5xl text-green-500 mx-auto mb-3" />
        <h1 className="text-xl font-semibold text-gray-900">You&rsquo;re already on Premium.</h1>
        <p className="text-sm text-gray-500 mt-2">
          {user.is_admin
            ? 'Premium is included with admin accounts.'
            : `Granted on ${user.premium_granted_at ? new Date(user.premium_granted_at).toLocaleDateString() : '—'}.`}
        </p>
        <button
          onClick={() => navigate({ to: '/settings/api-keys' as never })}
          className="mt-6 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
        >
          Manage API keys
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-8">
        <MdRocketLaunch className="text-5xl text-amber-500 mx-auto mb-2" />
        <h1 className="text-2xl font-semibold text-gray-900 m-0">Premium</h1>
        <p className="text-sm text-gray-500 mt-1">One-time payment unlocks the SFS API for the life of this account.</p>
      </div>

      <div className="border border-gray-200 rounded-2xl p-6 bg-white shadow-sm">
        <ul className="list-none p-0 m-0 mb-6 flex flex-col gap-2">
          {FEATURES.map((f) => (
            <li key={f} className="flex items-start gap-2 text-sm text-gray-700">
              <MdCheck className="text-green-500 shrink-0 mt-0.5" /> {f}
            </li>
          ))}
        </ul>

        {search.status === 'cancelled' && (
          <p className="text-sm text-amber-600 mb-4">Payment was cancelled. You can try again below.</p>
        )}
        {error && <p className="text-sm text-red-500 mb-4">{error}</p>}
        {capture.isPending && <p className="text-sm text-gray-500 mb-4">Confirming payment…</p>}

        <div className="flex flex-col sm:flex-row gap-3">
          <PayButton
            method="card"
            label="Pay with card"
            icon={<MdCreditCard className="text-xl" />}
            loading={createOrder.isPending && method === 'card'}
            onClick={() => { setMethod('card'); setError(null); createOrder.mutate('card') }}
          />
          <PayButton
            method="apple_pay"
            label="Pay with Apple Pay"
            icon={<MdPhoneIphone className="text-xl" />}
            loading={createOrder.isPending && method === 'apple_pay'}
            onClick={() => { setMethod('apple_pay'); setError(null); createOrder.mutate('apple_pay') }}
          />
        </div>
        <p className="text-xs text-gray-400 mt-3 text-center">
          Payments are processed by PayPal. You&rsquo;ll be redirected to complete checkout.
        </p>
      </div>
    </div>
  )
}

function PayButton({
  label, icon, loading, onClick,
}: { method: PaymentMethod; label: string; icon: React.ReactNode; loading: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 text-sm bg-gray-900 hover:bg-black text-white rounded-lg font-medium disabled:opacity-50 cursor-pointer transition-colors"
    >
      {icon} {loading ? 'Working…' : label}
    </button>
  )
}
