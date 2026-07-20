import { useEffect, useState } from 'react'
import {
  MdCheck,
  MdClose,
  MdRemove,
  MdRocketLaunch,
} from 'react-icons/md'
import { useBillingConfig } from '../hooks/useBillingConfig'
import { createPremiumSubscription, type PremiumPlan } from '../api/payments'
import { ApiError } from '../api/client'
import { PayPalSubscribeButton } from './PayPalSubscribeButton'
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

  const [plan, setPlan] = useState<PremiumPlan>('monthly')
  const [payError, setPayError] = useState<string | null>(null)

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
          ) : (
            <div className="flex flex-col gap-3">
              <div>
                <SectionLabel>Choose a plan</SectionLabel>
                <PremiumPlanSelector plans={plans} selected={plan} onSelect={setPlan} disabled={false} />
              </div>
              <PayPalSubscribeButton
                getApprovalUrl={handleGetApprovalUrl}
                onError={(msg) => { if (!payError) setPayError(msg) }}
                disabled={!canPay}
              />
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
