import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  MdCheck,
  MdClose,
  MdRemove,
  MdRocketLaunch,
} from 'react-icons/md'
import { useBillingConfig } from '../hooks/useBillingConfig'
import {
  createPremiumSubscription,
  createSelfBilledSubscriptionOrder,
  confirmSelfBilledSubscription,
  type PremiumPlan,
} from '../api/payments'
import { getPayPalClientToken } from '../api/billing'
import { ApiError } from '../api/client'
import { PayPalCheckoutOptions, CheckoutBackButton, type CheckoutSource } from './PayPalCheckoutOptions'
import {
  subscriptionManagementUrl,
  billingAgreementText,
  type RecurringTerms,
} from './recurringTerms'
import { HostedCardFields } from './HostedCardFields'
import { PremiumPlanSelector } from './PremiumPlanSelector'

interface Props {
  onClose: () => void
}

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
  const { data: config, isLoading: configLoading } = useBillingConfig()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [plan, setPlan] = useState<PremiumPlan>('monthly')
  const [payError, setPayError] = useState<string | null>(null)
  const [showCardForm, setShowCardForm] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const plans = config?.premium_plans ?? []
  const selectedPrice = plans.find((p) => p.plan === plan)?.price_cents ?? 0
  const canPay = selectedPrice > 0

  // Redirects the browser to PayPal's hosted approval page rather than using
  // react-paypal-js's popup-based <PayPalButtons> — see
  // PayPalWalletRedirectButton. PayPal redirects back to .../premium, whose
  // route already confirms the grant from the status/subscription_id search
  // params (see _auth.premium.tsx) — this modal's own tab navigates there, so
  // there is no in-modal "purchased" step to show any more.
  async function handleGetApprovalUrl(): Promise<string> {
    setPayError(null)
    try {
      const res = await createPremiumSubscription(plan)
      return res.approve_url
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not start checkout'
      setPayError(msg)
      throw err
    }
  }

  // Card and the two wallets can't approve a PayPal-managed subscription at
  // all — Subscriptions v1 ignores payment_source — so they buy the first
  // period as an ordinary order that vaults the payment method, and the API
  // bills every period after that itself. Same create/confirm pair the storage
  // add-ons use; the only difference is which endpoint it points at.
  async function handleCreateOrder(source: CheckoutSource): Promise<string> {
    setPayError(null)
    try {
      const res = await createSelfBilledSubscriptionOrder(plan, source)
      return res.order_id
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not start checkout'
      setPayError(msg)
      throw err
    }
  }

  async function handleApprove(orderId: string, source: CheckoutSource) {
    setBusy(true)
    setPayError(null)
    try {
      await confirmSelfBilledSubscription(orderId, plan, source)
      // Premium is granted server-side by the confirm call, so the cached
      // `me` (which gates every premium surface) is stale the moment it
      // returns.
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      onClose()
      navigate({ to: '/premium', search: { status: 'approved' } as never })
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Payment could not be completed'
      setPayError(msg)
      throw err
    } finally {
      setBusy(false)
    }
  }

  const selectedPriceLabel = `$${(selectedPrice / 100).toFixed(2)}`

  // Terms the Apple Pay / Google Pay sheets must disclose before the buyer
  // authorises — this is a subscription, and the saved payment method gets
  // billed again every period. See recurringTerms.ts.
  const recurringTerms: RecurringTerms = {
    description: 'Apollo SFS Premium',
    itemLabel: `Premium (${plan === 'annual' ? 'annual' : 'monthly'})`,
    intervalUnit: plan === 'annual' ? 'year' : 'month',
    intervalCount: 1,
    managementUrl: subscriptionManagementUrl(),
    billingAgreement: billingAgreementText(selectedPriceLabel, plan === 'annual' ? 'year' : 'month'),
  }

  return (
    <div
      onClick={onClose}
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
            className="text-gray-400 hover:text-gray-600 cursor-pointer transition-colors disabled:opacity-40 bg-transparent border-0 p-0"
          >
            <MdClose className="text-xl" />
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-5 flex flex-col gap-5">
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

          {configLoading ? (
            <p className="text-sm text-gray-400 m-0">Loading payment options…</p>
          ) : !config?.paypal_client_id ? (
            <p className="text-sm text-red-500 m-0">Payments are not configured.</p>
          ) : showCardForm ? (
            <div className="flex flex-col gap-3">
              <CheckoutBackButton
                onClick={() => { setShowCardForm(false); setPayError(null) }}
                disabled={busy}
              />
              <div className="flex items-center justify-between border border-gray-200 rounded-xl px-4 py-3">
                <span className="text-sm font-medium text-gray-800">
                  Premium — {plan === 'annual' ? 'annual' : 'monthly'}
                </span>
                <span className="text-sm font-semibold text-gray-800">
                  {selectedPriceLabel}/{plan === 'annual' ? 'yr' : 'mo'}
                </span>
              </div>
              {busy && <p className="text-xs text-gray-500 m-0">Completing your subscription…</p>}
              <HostedCardFields
                clientId={config.paypal_client_id}
                currency={config.currency || 'USD'}
                createOrder={() => handleCreateOrder('card')}
                onApprove={(orderId) => handleApprove(orderId, 'card')}
                onError={(msg) => { if (!payError) setPayError(msg) }}
                disabled={!canPay || busy}
                submitLabel={`Subscribe — ${selectedPriceLabel}`}
              />
              <p className="text-[11px] text-gray-400 text-center m-0">
                Your card is saved with PayPal to renew this subscription, and is charged
                {plan === 'annual' ? ' every year' : ' every month'} until you cancel. Card details are
                entered directly into PayPal and never touch our servers.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div>
                <SectionLabel>Choose a plan</SectionLabel>
                <PremiumPlanSelector plans={plans} selected={plan} onSelect={setPlan} disabled={busy} />
              </div>
              {busy && <p className="text-xs text-gray-500 m-0">Completing your subscription…</p>}
              <PayPalCheckoutOptions
                clientId={config.paypal_client_id}
                currency={config.currency || 'USD'}
                environment={config.environment === 'sandbox' ? 'sandbox' : 'live'}
                getClientToken={async () => (await getPayPalClientToken()).client_token}
                createOrder={handleCreateOrder}
                getApprovalUrl={handleGetApprovalUrl}
                onApprove={handleApprove}
                onError={(msg) => { if (!payError) setPayError(msg) }}
                amount={() => (selectedPrice / 100).toFixed(2)}
                canPay={canPay && !busy}
                onChooseCard={() => { setShowCardForm(true); setPayError(null) }}
                // Apple Pay is live-only (PayPal's sandbox can't verify a
                // second domain — see docs/paypal_setup.md §5), so under the
                // admin sandbox-payments toggle the tile is hidden rather than
                // silently failing eligibility.
                showApplePay={config.environment !== 'sandbox'}
                recurring={recurringTerms}
                googlePaySubscriptionsEnabled={config.google_pay_subscriptions_enabled}
              />
              <p className="text-[11px] text-gray-400 text-center m-0">
                Renews {plan === 'annual' ? 'yearly' : 'monthly'} until cancelled. Cancel any time from
                your profile.
              </p>
            </div>
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
