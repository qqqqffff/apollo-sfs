import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PayPalScriptProvider, PayPalButtons } from '@paypal/react-paypal-js'
import { MdCheckCircle, MdClose } from 'react-icons/md'
import {
  capturePayRemainingOrder,
  createPayRemainingOrder,
  formatCents,
  getBillingConfig,
  type ExpansionRequest,
} from '../api/billing'
import { ApiError } from '../api/client'

const TIB = 1024 ** 4

function formatCapacity(bytes: number): string {
  if (bytes >= 1024 * TIB) return `${(bytes / (1024 * TIB)).toFixed(1).replace(/\.0$/, '')} PB`
  if (bytes >= TIB) return `${(bytes / TIB).toFixed(1).replace(/\.0$/, '')} TB`
  return `${Math.round(bytes / 1024 ** 3)} GB`
}

// PayRemainingModal collects the outstanding balance on a provisioned
// ('expanded') expansion request via PayPal, completing the request.
export function PayRemainingModal({
  request, onClose,
}: {
  request: ExpansionRequest
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const { data: config } = useQuery({
    queryKey: ['billing', 'config'],
    queryFn: getBillingConfig,
    staleTime: 60 * 60 * 1000,
  })

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paid, setPaid] = useState(false)

  const remainingCents = request.full_price_cents - request.deposit_amount_cents
  const revertAt = request.payment_due_at
    ? new Date(new Date(request.payment_due_at).getTime() + 30 * 24 * 60 * 60 * 1000)
    : null

  return (
    <div
      onClick={() => { if (!busy) onClose() }}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-110 max-w-[92vw] max-h-[90vh] overflow-y-auto p-6"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900 m-0">Pay remaining balance</h3>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0 disabled:opacity-40"
          >
            <MdClose className="text-xl" />
          </button>
        </div>

        {paid ? (
          <div className="flex flex-col items-center text-center py-6 gap-3">
            <MdCheckCircle className="text-5xl text-green-500" />
            <h4 className="text-lg font-semibold text-gray-900 m-0">Balance paid</h4>
            <p className="text-sm text-gray-500 m-0">
              Your expansion request is complete — the capacity stays on your account.
            </p>
            <button
              onClick={onClose}
              className="mt-2 px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 mb-4 text-sm">
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-gray-500">Capacity</span>
                <span className="text-gray-800 font-medium">
                  {formatCapacity(request.bytes_requested)} {request.storage_type === 'nvme' ? 'Fast' : 'Standard'} · {request.server_name}
                </span>
              </div>
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-gray-500">Total</span>
                <span className="text-gray-800">{formatCents(request.full_price_cents)}</span>
              </div>
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-gray-500">Deposit paid</span>
                <span className="text-gray-800">−{formatCents(request.deposit_amount_cents)}</span>
              </div>
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-gray-700 font-semibold">Balance due</span>
                <span className="text-gray-900 font-bold">{formatCents(remainingCents)}</span>
              </div>
            </div>

            {revertAt && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
                The capacity is already active on your account. If the balance isn't paid by{' '}
                <span className="font-semibold">{revertAt.toLocaleDateString()}</span>, the allocation
                is removed and your deposit is not refunded.
              </p>
            )}

            {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
            {busy && <p className="text-xs text-gray-500 mb-3">Verifying payment…</p>}

            {config?.paypal_client_id ? (
              <PayPalScriptProvider
                options={{
                  clientId: config.paypal_client_id,
                  currency: config.currency || 'USD',
                  intent: 'capture',
                  components: 'buttons',
                  disableFunding: 'paylater',
                }}
              >
                <PayPalButtons
                  disabled={busy}
                  style={{ layout: 'vertical', shape: 'rect', label: 'pay' }}
                  createOrder={async () => {
                    setError(null)
                    const res = await createPayRemainingOrder(request.id)
                    return res.order_id
                  }}
                  onApprove={async (data) => {
                    setBusy(true)
                    try {
                      await capturePayRemainingOrder(request.id, data.orderID)
                      setPaid(true)
                      queryClient.invalidateQueries({ queryKey: ['billing'] })
                      queryClient.invalidateQueries({ queryKey: ['me'] })
                    } catch (err) {
                      setError(err instanceof ApiError ? err.message : 'Payment capture failed')
                    } finally {
                      setBusy(false)
                    }
                  }}
                  onError={(err) => setError(err instanceof Error ? err.message : 'Payment failed')}
                />
              </PayPalScriptProvider>
            ) : (
              <p className="text-sm text-red-500 m-0">Payments are not configured.</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
