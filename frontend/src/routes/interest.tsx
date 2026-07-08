import { createFileRoute } from '@tanstack/react-router'
import { useState, useRef, useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Turnstile } from '@marsidev/react-turnstile'
import type { TurnstileInstance } from '@marsidev/react-turnstile'
import {
  submitInterestForm,
  createInterestDepositOrder,
  captureInterestDepositOrder,
  validateApplePayMerchantForDeposit,
  createApplePayInterestDeposit,
  publicConfigQueryOptions,
  type StorageType,
} from '../api/interest'
import { ApiError } from '../api/client'
import { HostedCardFields } from '../components/HostedCardFields'

export const Route = createFileRoute('/interest')({
  component: RouteComponent,
})

const APPLE_PAY_MERCHANT_ID = 'merchant.com.apollosfs'

interface Plan {
  id: string
  label: string
  storageGB: number
  price: Record<StorageType, string>
  amount: Record<StorageType, string>
}

const PLANS: Plan[] = [
  { id: '64gb',  label: '64 GB',  storageGB: 64,   price: { nvme: '$30',  hdd: '$20'  }, amount: { nvme: '30.00',  hdd: '20.00'  } },
  { id: '128gb', label: '128 GB', storageGB: 128,  price: { nvme: '$50',  hdd: '$30'  }, amount: { nvme: '50.00',  hdd: '30.00'  } },
  { id: '256gb', label: '256 GB', storageGB: 256,  price: { nvme: '$80',  hdd: '$50'  }, amount: { nvme: '80.00',  hdd: '50.00'  } },
  { id: '512gb', label: '512 GB', storageGB: 512,  price: { nvme: '$150', hdd: '$80'  }, amount: { nvme: '150.00', hdd: '80.00'  } },
  { id: '1tb',   label: '1 TB',   storageGB: 1024, price: { nvme: '$250', hdd: '$120' }, amount: { nvme: '250.00', hdd: '120.00' } },
]

function depositAmt(plan: Plan, storageType: StorageType) {
  return (Math.round(parseFloat(plan.amount[storageType]) * 100 / 2) / 100).toFixed(2)
}

function depositDisplay(plan: Plan, storageType: StorageType) {
  return `$${depositAmt(plan, storageType)}`
}

type FormStep = 'form' | 'pending' | 'awaiting' | 'verifying' | 'submitted'

function RequiredStar() {
  return <span className="text-red-500 ml-0.5" aria-hidden="true">*</span>
}

function RouteComponent() {
  const { data: config } = useQuery(publicConfigQueryOptions)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [storageType, setStorageType] = useState<StorageType>('nvme')
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [useCase, setUseCase] = useState('')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [step, setStep] = useState<FormStep>('form')
  const [error, setError] = useState<string | null>(null)
  const [pendingOrderId, setPendingOrderId] = useState<string | null>(null)
  const [canApplePay, setCanApplePay] = useState(false)
  const turnstileRef = useRef<TurnstileInstance>(null)

  const selectedPlan = PLANS.find((p) => p.id === selectedPlanId) ?? null

  // Detect Apple Pay (Safari / WebKit only)
  useEffect(() => {
    const ApplePaySession = (window as any).ApplePaySession
    if (ApplePaySession?.canMakePayments) {
      try { setCanApplePay(ApplePaySession.canMakePayments(APPLE_PAY_MERCHANT_ID)) }
      catch { /* not available */ }
    }
  }, [])

  const submitMutation = useMutation({
    mutationFn: (depositOrderId: string) => {
      const plan = PLANS.find((p) => p.id === selectedPlanId)!
      return submitInterestForm({
        name: name.trim(),
        email: email.trim(),
        desired_storage_gb: plan.storageGB,
        storage_type: storageType,
        plan_id: selectedPlanId!,
        use_case: useCase.trim(),
        captcha_token: captchaToken!,
        deposit_order_id: depositOrderId,
      })
    },
    onSuccess: () => setStep('submitted'),
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Something went wrong — please try again.')
      setStep('form')
      turnstileRef.current?.reset()
      setCaptchaToken(null)
    },
  })

  function validateForm(): boolean {
    if (captchaRequired && !captchaToken) { setError('Please complete the security check.'); return false }
    if (!selectedPlanId) { setError('Please select a storage plan.'); return false }
    return true
  }

  // ── PayPal / Card ────────────────────────────────────────────────────────────

  async function handleRedirectPay(method: 'paypal' | 'card') {
    if (!validateForm()) return
    setError(null)
    setStep('pending')
    try {
      const { order_id, approve_url } = await createInterestDepositOrder(selectedPlanId!, storageType, method)
      setPendingOrderId(order_id)
      window.open(approve_url, '_blank', 'noopener,noreferrer')
      setStep('awaiting')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start payment — please try again.')
      setStep('form')
    }
  }

  async function handleVerifyDeposit() {
    if (!pendingOrderId) return
    setStep('verifying')
    try {
      await captureInterestDepositOrder(pendingOrderId)
      submitMutation.mutate(pendingOrderId)
    } catch {
      setError('Payment not found. If you completed checkout, please try again.')
      setStep('awaiting')
    }
  }

  // ── Apple Pay ────────────────────────────────────────────────────────────────

  function handleApplePay(e: React.MouseEvent) {
    e.preventDefault()
    if (!validateForm() || !selectedPlan) return
    setError(null)
    const ApplePaySession = (window as any).ApplePaySession
    const amount = depositAmt(selectedPlan, storageType)
    const session = new ApplePaySession(3, {
      countryCode: 'US',
      currencyCode: 'USD',
      supportedNetworks: ['visa', 'masterCard', 'amex', 'discover'],
      merchantCapabilities: ['supports3DS'],
      total: { label: 'Apollo SFS Storage Deposit', amount },
    })
    session.onvalidatemerchant = async (event: any) => {
      try {
        const merchantSession = await validateApplePayMerchantForDeposit(event.validationURL)
        session.completeMerchantValidation(merchantSession)
      } catch {
        session.abort()
        setError('Apple Pay merchant validation failed.')
      }
    }
    session.onpaymentauthorized = async (event: any) => {
      try {
        setStep('pending')
        const token = JSON.stringify(event.payment.token)
        const { order_id } = await createApplePayInterestDeposit(selectedPlanId!, storageType, token)
        session.completePayment(ApplePaySession.STATUS_SUCCESS)
        submitMutation.mutate(order_id)
      } catch {
        session.completePayment(ApplePaySession.STATUS_FAILURE)
        setError('Apple Pay payment failed — please try another method.')
        setStep('form')
      }
    }
    session.oncancel = () => setStep('form')
    session.begin()
  }

  // ── Hosted card fields (PCI-compliant inline entry) ───────────────────────────

  async function createCardOrder(): Promise<string> {
    if (!validateForm()) throw new Error('Please complete the required fields.')
    const { order_id } = await createInterestDepositOrder(selectedPlanId!, storageType, 'card')
    return order_id
  }

  async function handleCardApprove(orderId: string) {
    setStep('pending')
    try {
      await captureInterestDepositOrder(orderId)
      submitMutation.mutate(orderId)
    } catch {
      setError('Payment could not be completed — please try again.')
      setStep('form')
    }
  }

  // ── Submitted ────────────────────────────────────────────────────────────────

  if (step === 'submitted') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 max-w-md w-full text-center">
          <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Request received</h2>
          <p className="text-sm text-gray-500">
            Thanks for your interest in Apollo SFS. Your deposit has been received and will be
            refunded in full if your request is denied or expires. We'll be in touch if there's a
            spot available.
          </p>
        </div>
      </div>
    )
  }

  // ── PayPal / Card awaiting ────────────────────────────────────────────────────

  if (step === 'awaiting' || step === 'verifying') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 max-w-md w-full">
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Complete your deposit</h2>
          <p className="text-sm text-gray-500 mb-6">
            Payment opened in a new tab. Complete the{' '}
            {selectedPlan ? depositDisplay(selectedPlan, storageType) : ''} deposit there, then
            return here to confirm.
          </p>
          {error && <p className="text-sm text-red-500 mb-4">{error}</p>}
          <button
            type="button"
            onClick={handleVerifyDeposit}
            disabled={step === 'verifying'}
            className="w-full px-4 py-2.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50 transition-colors cursor-pointer mb-3"
          >
            {step === 'verifying' ? 'Verifying…' : "I've completed payment"}
          </button>
          <button
            type="button"
            onClick={() => { setStep('form'); setError(null) }}
            disabled={step === 'verifying'}
            className="w-full px-4 py-2.5 text-sm font-medium text-gray-500 hover:text-gray-700 rounded-lg disabled:opacity-50 transition-colors cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  // ── Main form ─────────────────────────────────────────────────────────────────

  const captchaRequired = !!config?.turnstile_site_key
  // Buttons are disabled only until a plan is selected; captcha errors surface inline
  const formReady = !!selectedPlanId
  const isPending = step === 'pending'

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 max-w-lg w-full">
        <h1 className="text-xl font-semibold text-gray-900 mb-1">Request access</h1>
        <p className="text-sm text-gray-500 mb-1">
          Apollo SFS is currently invite-only. Fill out this form and pay a refundable 50%
          deposit to reserve your spot.
        </p>
        <p className="text-xs text-gray-400 mb-6">
          Fields marked <span className="text-red-500">*</span> are required.
        </p>

        <div className="flex flex-col gap-5">
          {/* Name */}
          <div className="flex flex-col gap-1">
            <label htmlFor="name" className="text-sm font-medium text-gray-700">
              Full name<RequiredStar />
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={1}
              maxLength={120}
              placeholder="Jane Smith"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* Email */}
          <div className="flex flex-col gap-1">
            <label htmlFor="email" className="text-sm font-medium text-gray-700">
              Email address<RequiredStar />
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              maxLength={254}
              placeholder="jane@example.com"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* Storage type toggle */}
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-gray-700">Storage type</span>
            <div className="grid grid-cols-2 gap-2">
              {(['nvme', 'hdd'] as StorageType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setStorageType(t)}
                  className={`flex flex-col items-start px-4 py-3 rounded-xl border-2 transition-colors cursor-pointer text-left ${
                    storageType === t
                      ? 'border-blue-600 bg-blue-50'
                      : 'border-gray-200 bg-white hover:border-gray-300'
                  }`}
                >
                  <span className={`text-sm font-semibold ${storageType === t ? 'text-blue-700' : 'text-gray-800'}`}>
                    {t === 'nvme' ? 'Fast' : 'Standard'}
                  </span>
                  <span className={`text-xs ${storageType === t ? 'text-blue-500' : 'text-gray-400'}`}>
                    {t === 'nvme' ? 'NVMe SSD' : 'HDD'}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Plan cards */}
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-gray-700">
              Storage plan<RequiredStar />
            </span>
            {PLANS.map((plan) => {
              const sel = selectedPlanId === plan.id
              return (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => setSelectedPlanId(plan.id)}
                  className={`flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-colors cursor-pointer text-left ${
                    sel
                      ? 'border-blue-600 bg-blue-50'
                      : 'border-gray-200 bg-white hover:border-gray-300'
                  }`}
                >
                  <span className={`text-sm font-semibold ${sel ? 'text-blue-700' : 'text-gray-800'}`}>
                    {plan.label}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className={`text-sm font-semibold ${sel ? 'text-blue-600' : 'text-gray-500'}`}>
                      {plan.price[storageType]}
                    </span>
                    <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                      sel ? 'border-blue-600' : 'border-gray-300'
                    }`}>
                      {sel && <div className="w-2 h-2 rounded-full bg-blue-600" />}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          {/* Deposit notice */}
          {selectedPlan && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
              A <span className="font-semibold">{depositDisplay(selectedPlan, storageType)} refundable deposit (50%)</span> is
              required to reserve your spot. It will be returned automatically if your request is
              denied or expires.
            </div>
          )}

          {/* Use case */}
          <div className="flex flex-col gap-1">
            <label htmlFor="use-case" className="text-sm font-medium text-gray-700">
              Reason / use case<RequiredStar />
            </label>
            <textarea
              id="use-case"
              value={useCase}
              onChange={(e) => setUseCase(e.target.value)}
              required
              minLength={1}
              maxLength={2000}
              rows={4}
              placeholder="Briefly describe how you'd use Apollo SFS…"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            />
          </div>

          {/* Cloudflare Turnstile */}
          {config?.turnstile_site_key && (
            <div>
              <Turnstile
                ref={turnstileRef}
                siteKey={config.turnstile_site_key}
                onSuccess={(token) => setCaptchaToken(token)}
                onExpire={() => setCaptchaToken(null)}
                onError={() => setCaptchaToken(null)}
              />
            </div>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}

          {/* Payment buttons */}
          <div className="flex flex-col gap-2">
            {canApplePay && (
              <button
                type="button"
                onClick={handleApplePay}
                disabled={!formReady || isPending}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold bg-black hover:bg-gray-900 text-white rounded-xl disabled:opacity-50 transition-colors cursor-pointer"
              >
                {isPending ? 'Processing…' : (
                  <> Pay{selectedPlan ? ` ${depositDisplay(selectedPlan, storageType)}` : ''}</>
                )}
              </button>
            )}


            <button
              type="button"
              onClick={() => handleRedirectPay('paypal')}
              disabled={!formReady || isPending}
              aria-label="PayPal"
              className="w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold bg-[#003087] hover:bg-[#002070] text-white rounded-xl disabled:opacity-50 transition-colors cursor-pointer"
            >
              <span className="font-light text-[#009cde] tracking-wide">Pay</span>
              <span className="font-black text-[#009cde] tracking-wide -ml-1.5">Pal</span>
              {selectedPlan && (
                <span className="text-white/90 ml-1">
                  — {depositDisplay(selectedPlan, storageType)}
                </span>
              )}
            </button>

            {/* Google Pay (PayPal-orchestrated) + PCI-compliant hosted card
                fields — card data is keyed into PayPal-hosted iframes, never our
                page. Both share one PayPal SDK provider inside HostedCardFields. */}
            {config?.paypal_client_id && (
              <div className={`mt-1 ${formReady && !isPending ? '' : 'opacity-50 pointer-events-none'}`}>
                <HostedCardFields
                  clientId={config.paypal_client_id}
                  currency={config.paypal_currency || 'USD'}
                  createOrder={createCardOrder}
                  onApprove={handleCardApprove}
                  onError={(msg) => setError(msg)}
                  disabled={!formReady || isPending}
                  submitLabel={`Pay by Card${selectedPlan ? ` — ${depositDisplay(selectedPlan, storageType)}` : ''}`}
                  googlePayAmount={() => (selectedPlan ? depositAmt(selectedPlan, storageType) : '0.00')}
                  environment={config.paypal_environment === 'sandbox' ? 'sandbox' : 'live'}
                />
              </div>
            )}

            {!formReady && !error && (
              <p className="text-xs text-gray-400 text-center">
                Select a plan to enable payment.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
