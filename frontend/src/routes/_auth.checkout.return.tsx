import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { MdCheckCircle, MdErrorOutline } from 'react-icons/md'
import { captureStorageOrder, captureExpansionOrder, capturePayRemainingOrder } from '../api/billing'
import { ApiError } from '../api/client'

type Flow = 'storage' | 'expansion' | 'pay_remaining'

interface Search {
  flow?: Flow
  token?: string // PayPal order id, appended by PayPal on redirect back
  request_id?: string // expansion request id — only needed for pay_remaining
  cancelled?: boolean
}

// Where the "PayPal" wallet button (PayPalWalletRedirectButton) sends the
// browser back to after the shopper approves or cancels on PayPal's hosted
// page — see billing.Handler/expansion.Handler's platform=web return_url
// construction. Handles storage/expansion/pay_remaining; the premium
// subscription flow has its own return handling on /premium, and the
// interest-form deposit is handled inline on /interest (both need to restore
// client-only state the backend doesn't have, so they don't share this page).
export const Route = createFileRoute('/_auth/checkout/return')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    flow: search.flow === 'storage' || search.flow === 'expansion' || search.flow === 'pay_remaining' ? search.flow : undefined,
    token: typeof search.token === 'string' ? search.token : undefined,
    request_id: typeof search.request_id === 'string' ? search.request_id : undefined,
    cancelled: search.cancelled === '1' || search.cancelled === true,
  }),
  component: RouteComponent,
})

const FLOW_LABEL: Record<Flow, string> = {
  storage: 'storage purchase',
  expansion: 'expansion deposit',
  pay_remaining: 'remaining balance payment',
}

const FLOW_CONTINUE: Record<Flow, { to: '/client' | '/client/orders'; label: string }> = {
  storage: { to: '/client', label: 'Go to your files' },
  expansion: { to: '/client/orders', label: 'View your orders' },
  pay_remaining: { to: '/client/orders', label: 'View your orders' },
}

function RouteComponent() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const search = useSearch({ from: '/_auth/checkout/return' })
  const [status, setStatus] = useState<'capturing' | 'success' | 'error'>('capturing')
  const [error, setError] = useState<string | null>(null)
  const triggered = useRef(false)

  useEffect(() => {
    if (triggered.current) return
    triggered.current = true

    if (search.cancelled) {
      setStatus('error')
      setError('Checkout was cancelled — no payment was taken.')
      return
    }
    if (!search.flow || !search.token) {
      setStatus('error')
      setError('Missing checkout details.')
      return
    }

    ;(async () => {
      try {
        if (search.flow === 'storage') {
          await captureStorageOrder(search.token!)
          await queryClient.invalidateQueries({ queryKey: ['me'] })
          queryClient.invalidateQueries({ queryKey: ['storage'] })
        } else if (search.flow === 'expansion') {
          await captureExpansionOrder(search.token!)
          queryClient.invalidateQueries({ queryKey: ['billing', 'expansion-requests'] })
        } else {
          if (!search.request_id) throw new Error('Missing request reference.')
          await capturePayRemainingOrder(search.request_id, search.token!)
          queryClient.invalidateQueries({ queryKey: ['billing'] })
          await queryClient.invalidateQueries({ queryKey: ['me'] })
        }
        setStatus('success')
      } catch (err) {
        setStatus('error')
        setError(err instanceof ApiError ? err.message : 'Payment could not be completed — please try again.')
      }
    })()
  }, [search.flow, search.token, search.request_id, search.cancelled, queryClient])

  const flow = search.flow ?? 'storage'
  const continueTo = FLOW_CONTINUE[flow]

  return (
    <div className="max-w-md mx-auto text-center py-16">
      {status === 'capturing' && (
        <p className="text-sm text-gray-500">Finishing your {FLOW_LABEL[flow]}…</p>
      )}
      {status === 'success' && (
        <>
          <MdCheckCircle className="text-5xl text-green-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-gray-900">Payment complete</h1>
          <p className="text-sm text-gray-500 mt-2">Your {FLOW_LABEL[flow]} was processed successfully.</p>
        </>
      )}
      {status === 'error' && (
        <>
          <MdErrorOutline className="text-5xl text-red-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-gray-900">
            {search.cancelled ? 'Checkout cancelled' : 'Something went wrong'}
          </h1>
          <p className="text-sm text-gray-500 mt-2">{error}</p>
        </>
      )}
      {status !== 'capturing' && (
        <button
          onClick={() => navigate({ to: continueTo.to })}
          className="mt-6 px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
        >
          {continueTo.label}
        </button>
      )}
    </div>
  )
}
