import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MdClose } from 'react-icons/md'
import {
  createPayRemainingOrder,
  formatCents,
  getBillingConfig,
  type ExpansionRequest,
} from '../api/billing'
import { ApiError } from '../api/client'
import { PayPalWalletRedirectButton } from './PayPalWalletRedirectButton'

const TIB = 1024 ** 4

function formatCapacity(bytes: number): string {
  if (bytes >= 1024 * TIB) return `${(bytes / (1024 * TIB)).toFixed(1).replace(/\.0$/, '')} PB`
  if (bytes >= TIB) return `${(bytes / TIB).toFixed(1).replace(/\.0$/, '')} TB`
  return `${Math.round(bytes / 1024 ** 3)} GB`
}

// PayRemainingModal collects the outstanding balance on a provisioned
// ('expanded') expansion request via PayPal, completing the request. The
// "PayPal" button redirects the browser to PayPal's hosted approval page
// (see PayPalWalletRedirectButton) rather than using a popup — approval and
// capture happen on /checkout/return after the redirect back, not in this
// modal, since a full-page redirect leaves it behind.
export function PayRemainingModal({
  request, onClose,
}: {
  request: ExpansionRequest
  onClose: () => void
}) {
  const { data: config } = useQuery({
    queryKey: ['billing', 'config'],
    queryFn: getBillingConfig,
    staleTime: 60 * 60 * 1000,
  })

  const [error, setError] = useState<string | null>(null)

  const remainingCents = request.full_price_cents - request.deposit_amount_cents
  const revertAt = request.payment_due_at
    ? new Date(new Date(request.payment_due_at).getTime() + 30 * 24 * 60 * 60 * 1000)
    : null

  async function handleGetApprovalUrl(): Promise<string> {
    setError(null)
    try {
      const res = await createPayRemainingOrder(request.id)
      return res.approval_url
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not start checkout'
      setError(msg)
      throw err
    }
  }

  return (
    <div
      onClick={onClose}
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
            className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0 disabled:opacity-40"
          >
            <MdClose className="text-xl" />
          </button>
        </div>

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

        {config?.paypal_client_id ? (
          <PayPalWalletRedirectButton getApprovalUrl={handleGetApprovalUrl} onError={(msg) => setError(msg)} />
        ) : (
          <p className="text-sm text-red-500 m-0">Payments are not configured.</p>
        )}
      </div>
    </div>
  )
}
