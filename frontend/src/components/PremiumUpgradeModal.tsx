import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  PayPalScriptProvider,
  PayPalButtons,
} from '@paypal/react-paypal-js'
import {
  MdArrowBack,
  MdCheck,
  MdCheckCircle,
  MdClose,
  MdRemove,
  MdRocketLaunch,
} from 'react-icons/md'
import { getBillingConfig, formatCents } from '../api/billing'
import { createPremiumWalletOrder, capturePaymentOrder } from '../api/payments'
import { ApiError } from '../api/client'
import { PayPalGooglePayButton } from './PayPalGooglePayButton'
import { HostedCardFields } from './HostedCardFields'

interface Props {
  onClose: () => void
}

type Phase = 'select' | 'purchased'

// Base vs Premium, grounded in what the API actually gates on is_premium
// (per-directory API keys, the SFS S3-compatible API, and file-server WebDAV
// links) rather than aspirational marketing copy.
const COMPARISON: { label: string; base: boolean; premium: boolean }[] = [
  { label: 'Web file browser, uploads & sharing', base: true, premium: true },
  { label: 'Purchase additional storage capacity', base: true, premium: true },
  { label: 'End-to-end file encryption', base: true, premium: true },
  { label: 'SFS S3-compatible API', base: false, premium: true },
  { label: 'Per-directory scoped API keys', base: false, premium: true },
  { label: 'Premium file-server (WebDAV) mounts', base: false, premium: true },
  { label: 'Priority support', base: false, premium: true },
]

export function PremiumUpgradeModal({ onClose }: Props) {
  const queryClient = useQueryClient()

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: ['billing', 'config'],
    queryFn: getBillingConfig,
    staleTime: 60 * 60 * 1000,
  })

  const [phase, setPhase] = useState<Phase>('select')
  const [showCardForm, setShowCardForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, busy])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const priceCents = config?.premium_price_cents ?? 0
  const canPay = phase === 'select' && !busy && priceCents > 0

  async function handleCreateOrder(): Promise<string> {
    setPayError(null)
    try {
      const res = await createPremiumWalletOrder()
      return res.order_id
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not start checkout'
      setPayError(msg)
      throw err
    }
  }

  async function handleApprove(orderId: string) {
    setBusy(true)
    setPayError(null)
    try {
      await capturePaymentOrder(orderId)
      setPhase('purchased')
      await queryClient.invalidateQueries({ queryKey: ['me'] })
    } catch (err) {
      setPayError(err instanceof ApiError ? err.message : 'Payment capture failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      onClick={() => { if (!busy) onClose() }}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-130 max-w-[94vw] max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-2">
            <MdRocketLaunch className="text-amber-500 text-xl shrink-0" />
            <h3 className="text-base font-semibold text-gray-900 m-0">Upgrade to Premium</h3>
            {config?.environment === 'sandbox' && (
              <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-purple-100 text-purple-700 rounded">
                Sandbox payment
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-gray-400 hover:text-gray-600 cursor-pointer transition-colors disabled:opacity-40 bg-transparent border-0 p-0"
          >
            <MdClose className="text-xl" />
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-5 flex flex-col gap-5">
          {phase === 'purchased' && (
            <div className="flex flex-col items-center text-center py-6 gap-3">
              <MdCheckCircle className="text-5xl text-green-500" />
              <h4 className="text-lg font-semibold text-gray-900 m-0">Premium activated</h4>
              <p className="text-sm text-gray-500 m-0 max-w-sm">
                You now have access to the SFS S3-compatible API, per-directory API keys, and
                premium file-server mounts.
              </p>
              <button
                onClick={onClose}
                className="mt-2 px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
              >
                Done
              </button>
            </div>
          )}

          {phase === 'select' && showCardForm && (
            <>
              <button
                onClick={() => { setShowCardForm(false); setPayError(null) }}
                disabled={busy}
                className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 cursor-pointer bg-transparent border-0 p-0 transition-colors disabled:opacity-40"
              >
                <MdArrowBack className="text-base" /> Back
              </button>

              <div className="border border-gray-200 rounded-xl px-4 py-3 flex items-center justify-between">
                <span className="text-sm font-medium text-gray-800">Premium — one-time payment</span>
                <span className="text-sm font-semibold text-gray-800">{formatCents(priceCents)}</span>
              </div>

              {payError && <p className="text-xs text-red-500 m-0">{payError}</p>}
              {busy && <p className="text-xs text-gray-500 m-0">Verifying payment…</p>}

              {config?.paypal_client_id && (
                <HostedCardFields
                  clientId={config.paypal_client_id}
                  currency={config.currency || 'USD'}
                  createOrder={handleCreateOrder}
                  onApprove={handleApprove}
                  onError={(msg) => { if (!payError) setPayError(msg) }}
                  disabled={!canPay}
                  submitLabel={`Pay ${formatCents(priceCents)}`}
                  googlePayAmount={() => (priceCents / 100).toFixed(2)}
                  environment={config.environment}
                />
              )}
              <p className="text-[11px] text-gray-400 text-center m-0">
                Payments are processed securely by PayPal. Card details are entered directly into
                PayPal and never touch our servers.
              </p>
            </>
          )}

          {phase === 'select' && !showCardForm && (
            <>
              {/* Base vs Premium comparison */}
              <div>
                <SectionLabel>Premium vs Base</SectionLabel>
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="grid grid-cols-[1fr_56px_64px] text-[11px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-50 px-4 py-2">
                    <span>Feature</span>
                    <span className="text-center">Base</span>
                    <span className="text-center">Premium</span>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {COMPARISON.map((row) => (
                      <div key={row.label} className="grid grid-cols-[1fr_56px_64px] items-center px-4 py-2.5">
                        <span className="text-sm text-gray-700">{row.label}</span>
                        <span className="flex justify-center">
                          {row.base
                            ? <MdCheck className="text-green-500 text-base" />
                            : <MdRemove className="text-gray-300 text-base" />}
                        </span>
                        <span className="flex justify-center">
                          {row.premium
                            ? <MdCheck className="text-amber-500 text-base" />
                            : <MdRemove className="text-gray-300 text-base" />}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {payError && <p className="text-xs text-red-500 m-0">{payError}</p>}
              {busy && <p className="text-xs text-gray-500 m-0">Verifying payment…</p>}

              {configLoading ? (
                <p className="text-sm text-gray-400 m-0">Loading payment options…</p>
              ) : !config?.paypal_client_id ? (
                <p className="text-sm text-red-500 m-0">Payments are not configured.</p>
              ) : (
                <div className={canPay ? '' : 'opacity-50 pointer-events-none'}>
                  <p className="text-xs text-gray-500 mb-2 mt-0">
                    One-time payment: {formatCents(priceCents)}
                  </p>
                  <PayPalScriptProvider
                    options={{
                      clientId: config.paypal_client_id,
                      currency: config.currency || 'USD',
                      intent: 'capture',
                      components: 'buttons,googlepay',
                      // 'card' is disabled here for the same reason as the storage
                      // modal — that funding source sends the shopper to PayPal's
                      // hosted guest-checkout page. "Pay with card" below uses
                      // HostedCardFields instead, which stays in-modal.
                      disableFunding: 'paylater,card',
                    }}
                  >
                    <PayPalGooglePayButton
                      environment={config.environment}
                      currencyCode={config.currency || 'USD'}
                      amount={() => (priceCents / 100).toFixed(2)}
                      createOrder={handleCreateOrder}
                      onApprove={handleApprove}
                      onError={(msg) => { if (!payError) setPayError(msg) }}
                      enabled={canPay}
                    />
                    <PayPalButtons
                      disabled={!canPay}
                      style={{ layout: 'vertical', shape: 'rect', label: 'pay' }}
                      createOrder={handleCreateOrder}
                      onApprove={(data) => handleApprove(data.orderID)}
                      onError={(err) => {
                        if (!payError) setPayError(err instanceof Error ? err.message : 'Payment failed')
                      }}
                      onCancel={() => setPayError(null)}
                    />
                  </PayPalScriptProvider>
                  <button
                    onClick={() => { setPayError(null); setShowCardForm(true) }}
                    disabled={!canPay}
                    className="w-full mt-2 px-4 py-2.5 text-sm border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 disabled:opacity-50 cursor-pointer transition-colors"
                  >
                    Pay with card
                  </button>
                  <p className="text-[11px] text-gray-400 text-center m-0">
                    Payments are processed securely by PayPal.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-0 mb-2">{children}</h4>
  )
}
