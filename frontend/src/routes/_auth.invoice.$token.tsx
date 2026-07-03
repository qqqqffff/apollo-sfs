import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { PayPalScriptProvider, PayPalButtons } from '@paypal/react-paypal-js'
import { MdCheckCircle, MdErrorOutline } from 'react-icons/md'
import {
  acceptInvoice,
  captureInvoiceDepositOrder,
  createInvoiceDepositOrder,
  declineInvoice,
  formatCents,
  getBillingConfig,
  getInvoiceByToken,
} from '../api/billing'
import { ApiError } from '../api/client'
import { InvoiceDocument } from '../components/InvoiceDocument'

export const Route = createFileRoute('/_auth/invoice/$token')({
  component: RouteComponent,
})

function RouteComponent() {
  const { token } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['billing', 'invoice', token],
    queryFn: () => getInvoiceByToken(token),
  })
  const { data: config } = useQuery({
    queryKey: ['billing', 'config'],
    queryFn: getBillingConfig,
    staleTime: 60 * 60 * 1000,
  })

  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [done, setDone] = useState<'accepted' | 'declined' | null>(null)

  if (isLoading) return <p className="text-sm text-gray-500">Loading invoice…</p>
  if (error || !data) {
    return (
      <div className="max-w-lg mx-auto text-center py-12">
        <MdErrorOutline className="text-5xl text-red-400 mx-auto mb-3" />
        <p className="text-sm text-gray-500">
          {error instanceof ApiError ? error.message : 'Invoice not found.'}
        </p>
      </div>
    )
  }

  const { invoice, request } = data
  const pending = invoice.status === 'sent' && !done
  const expiredWindow = pending && new Date(invoice.accept_due_at).getTime() < Date.now()

  async function handleAcceptNoDeposit() {
    setBusy(true)
    setActionError(null)
    try {
      await acceptInvoice(token)
      setDone('accepted')
      queryClient.invalidateQueries({ queryKey: ['billing'] })
      refetch()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not accept invoice')
    } finally {
      setBusy(false)
    }
  }

  async function handleDecline() {
    if (!window.confirm('Decline this invoice? Your custom capacity request will be closed.')) return
    setBusy(true)
    setActionError(null)
    try {
      await declineInvoice(token)
      setDone('declined')
      queryClient.invalidateQueries({ queryKey: ['billing'] })
      refetch()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not decline invoice')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <h2 className="text-lg font-semibold text-gray-900 m-0">Invoice {invoice.invoice_number}</h2>

      {(invoice.status === 'accepted' || done === 'accepted') && (
        <div className="flex items-start gap-2 px-4 py-3 bg-green-50 border border-green-200 rounded-xl">
          <MdCheckCircle className="text-green-500 text-lg shrink-0 mt-0.5" />
          <p className="text-sm text-green-800 m-0">
            Invoice accepted{invoice.deposit_cents > 0 ? ' and deposit paid' : ''}. Your request is now
            with our team for approval — once approved, capacity is expanded within 14 business days.
          </p>
        </div>
      )}
      {(invoice.status === 'cancelled' || done === 'declined') && (
        <div className="px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl">
          <p className="text-sm text-gray-600 m-0">This invoice was declined or superseded.</p>
        </div>
      )}
      {(invoice.status === 'expired' || expiredWindow) && (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl">
          <p className="text-sm text-red-700 m-0">
            The acceptance window for this invoice has expired and the request was closed.
          </p>
        </div>
      )}

      <InvoiceDocument invoice={invoice} request={request} />

      {pending && !expiredWindow && (
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-4 flex flex-col gap-3">
          <p className="text-sm text-gray-600 m-0">
            Please review and accept by{' '}
            <span className="font-semibold text-gray-800">
              {new Date(invoice.accept_due_at).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
            </span>
            {invoice.deposit_cents > 0 && (
              <> — a deposit of <span className="font-semibold text-gray-800">{formatCents(invoice.deposit_cents)}</span> is
              due on acceptance; the remaining balance is charged after your capacity is provisioned.</>
            )}
          </p>

          {actionError && <p className="text-xs text-red-500 m-0">{actionError}</p>}
          {busy && <p className="text-xs text-gray-500 m-0">Working…</p>}

          {invoice.deposit_cents > 0 ? (
            config?.paypal_client_id ? (
              <PayPalScriptProvider
                options={{
                  clientId: config.paypal_client_id,
                  currency: config.currency || 'USD',
                  intent: 'capture',
                  components: 'buttons',
                }}
              >
                <PayPalButtons
                  disabled={busy}
                  style={{ layout: 'vertical', shape: 'rect', label: 'pay' }}
                  createOrder={async () => {
                    setActionError(null)
                    const res = await createInvoiceDepositOrder(token)
                    return res.order_id
                  }}
                  onApprove={async (payData) => {
                    setBusy(true)
                    try {
                      await captureInvoiceDepositOrder(token, payData.orderID)
                      setDone('accepted')
                      queryClient.invalidateQueries({ queryKey: ['billing'] })
                      refetch()
                    } catch (err) {
                      setActionError(err instanceof ApiError ? err.message : 'Payment capture failed')
                    } finally {
                      setBusy(false)
                    }
                  }}
                  onError={(err) => setActionError(err instanceof Error ? err.message : 'Payment failed')}
                />
              </PayPalScriptProvider>
            ) : (
              <p className="text-sm text-red-500 m-0">Payments are not configured.</p>
            )
          ) : (
            <button
              onClick={handleAcceptNoDeposit}
              disabled={busy}
              className="px-4 py-2.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50 cursor-pointer transition-colors"
            >
              Accept invoice
            </button>
          )}

          <button
            onClick={handleDecline}
            disabled={busy}
            className="self-start text-xs text-gray-400 hover:text-red-500 bg-transparent border-0 p-0 cursor-pointer transition-colors"
          >
            Decline this invoice
          </button>
        </div>
      )}

      <button
        onClick={() => navigate({ to: '/client/profile' as never })}
        className="text-xs text-blue-600 hover:text-blue-700 bg-transparent border-0 p-0 cursor-pointer"
      >
        ← Back to profile
      </button>
    </div>
  )
}
