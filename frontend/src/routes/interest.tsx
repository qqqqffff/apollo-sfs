import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useRef, useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Turnstile } from '@marsidev/react-turnstile'
import type { TurnstileInstance } from '@marsidev/react-turnstile'
import { MdArrowBack, MdScience } from 'react-icons/md'
import {
  submitInterestForm,
  createInterestDepositOrder,
  captureInterestDepositOrder,
  getPublicPayPalClientToken,
  publicConfigQueryOptions,
  type StorageType,
} from '../api/interest'
import { ApiError } from '../api/client'
import { HostedCardFields } from '../components/HostedCardFields'
import { PayPalCheckoutOptions, CheckoutBackButton } from '../components/PayPalCheckoutOptions'

export const Route = createFileRoute('/interest')({
  component: RouteComponent,
  // sandbox: set by the admin profile page's "Open account request form"
  // link (see SandboxAccountRequestCard in profile.tsx) when sandbox
  // payments are enabled — flags this pass through the public form as an
  // admin sandbox test rather than a real request, since this page has no
  // authenticated session to read that context from otherwise.
  validateSearch: (search: Record<string, unknown>): { sandbox?: boolean } => ({
    sandbox: search.sandbox === true || search.sandbox === 'true' ? true : undefined,
  }),
})

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

type FormStep = 'form' | 'pending' | 'submitted'

// Persisted across the full-page redirect to PayPal and back — the deposit
// order row (api/routes/interest_deposit.go) only has plan_id/storage_type,
// not name/email/use_case, so those need to survive client-side.
// captcha_token is deliberately excluded: Turnstile tokens are short-lived
// and are re-collected once the shopper is back.
interface SavedInterestState {
  name: string
  email: string
  storageType: StorageType
  selectedPlanId: string
  useCase: string
}
const INTEREST_RESUME_KEY = 'apollo-sfs:interest-resume'

function RequiredStar() {
  return <span className="text-red-500 ml-0.5" aria-hidden="true">*</span>
}

function RouteComponent() {
  const { data: config } = useQuery(publicConfigQueryOptions)
  const navigate = useNavigate()
  const { sandbox } = Route.useSearch()

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [storageType, setStorageType] = useState<StorageType>('nvme')
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [useCase, setUseCase] = useState('')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [step, setStep] = useState<FormStep>('form')
  const [error, setError] = useState<string | null>(null)
  const [showCardForm, setShowCardForm] = useState(false)
  const [resumeOrderId, setResumeOrderId] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileInstance>(null)
  const resumeTriggered = useRef(false)

  const selectedPlan = PLANS.find((p) => p.id === selectedPlanId) ?? null

  const captchaRequired = !!config?.turnstile_site_key

  // Landed back here after a full-page redirect to PayPal (see
  // handleGetApprovalUrl / PayPalWalletRedirectButton) — restore the fields
  // that only ever lived client-side and, once the shopper solves a fresh
  // Turnstile challenge, finish the request automatically.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')
    const cancelled = params.get('cancelled')
    if (!token && !cancelled) return
    window.history.replaceState(null, '', window.location.pathname)
    if (cancelled) {
      sessionStorage.removeItem(INTEREST_RESUME_KEY)
      return
    }
    const raw = sessionStorage.getItem(INTEREST_RESUME_KEY)
    sessionStorage.removeItem(INTEREST_RESUME_KEY)
    if (!raw) {
      // An order id came back but we have nothing to resume with (e.g.
      // sessionStorage was cleared) — the deposit may have gone through, but
      // submitting the request needs name/email/use_case, which only ever
      // lived client-side, so there's nothing safe to auto-complete.
      setError(`Your payment may have gone through, but we couldn't recover your request. Please contact support with this reference: ${token}`)
      return
    }
    const saved = JSON.parse(raw) as SavedInterestState
    setName(saved.name)
    setEmail(saved.email)
    setStorageType(saved.storageType)
    setSelectedPlanId(saved.selectedPlanId)
    setUseCase(saved.useCase)
    setResumeOrderId(token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!config || !resumeOrderId || resumeTriggered.current) return
    if (captchaRequired && !captchaToken) return
    resumeTriggered.current = true
    const orderId = resumeOrderId
    setResumeOrderId(null)
    handleDepositApprove(orderId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, resumeOrderId, captchaRequired, captchaToken])

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

  // Returns the specific reason the form isn't ready to submit, or null when
  // it is. Callers below both display this message directly and thread it
  // into the Error they throw, so the button components' generic onError
  // handler (which just does setError(msg)) re-sets the SAME message instead
  // of clobbering it with an unrelated one.
  function validationError(): string | null {
    if (captchaRequired && !captchaToken) return 'Please complete the security check.'
    if (!selectedPlanId) return 'Please select a storage plan.'
    return null
  }

  // ── PayPal wallet button + Google Pay (inline; same order create/capture
  // pattern as the storage and premium upgrade checkouts) ───────────────────

  async function handleCreateOrder(): Promise<string> {
    setError(null)
    const invalid = validationError()
    if (invalid) { setError(invalid); throw new Error(invalid) }
    try {
      const { order_id } = await createInterestDepositOrder(selectedPlanId!, storageType, 'paypal')
      return order_id
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start checkout')
      throw err
    }
  }

  // For the "PayPal" wallet button, which redirects the browser to PayPal's
  // approval page rather than using createOrder+onApprove's popup (see
  // PayPalWalletRedirectButton) — persists the fields the deposit order can't
  // hold server-side so they survive the round trip (see SavedInterestState).
  async function handleGetApprovalUrl(): Promise<string> {
    setError(null)
    const invalid = validationError()
    if (invalid) { setError(invalid); throw new Error(invalid) }
    try {
      const { approve_url } = await createInterestDepositOrder(selectedPlanId!, storageType, 'paypal')
      const saved: SavedInterestState = { name, email, storageType, selectedPlanId: selectedPlanId!, useCase }
      sessionStorage.setItem(INTEREST_RESUME_KEY, JSON.stringify(saved))
      return approve_url
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start checkout')
      throw err
    }
  }

  async function handleDepositApprove(orderId: string) {
    setStep('pending')
    try {
      await captureInterestDepositOrder(orderId)
      submitMutation.mutate(orderId)
    } catch {
      setError('Payment could not be completed — please try again.')
      setStep('form')
    }
  }

  function handleChooseCard() {
    const invalid = validationError()
    if (invalid) { setError(invalid); return }
    setError(null)
    setShowCardForm(true)
  }

  // ── Hosted card fields (PCI-compliant inline entry) ───────────────────────────

  async function createCardOrder(): Promise<string> {
    setError(null)
    const invalid = validationError()
    if (invalid) { setError(invalid); throw new Error(invalid) }
    try {
      const { order_id } = await createInterestDepositOrder(selectedPlanId!, storageType, 'card')
      return order_id
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start checkout')
      throw err
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

  // ── Resuming after a PayPal redirect (see the useEffects above) ─────────────

  if (resumeOrderId) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 max-w-md w-full text-center">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Finishing up…</h2>
          <p className="text-sm text-gray-500 mb-4">
            Your payment was received.{' '}
            {captchaRequired ? 'Complete the security check below to finish submitting your request.' : 'Submitting your request…'}
          </p>
          {error && <p className="text-sm text-red-500 mb-4">{error}</p>}
          {captchaRequired && config?.turnstile_site_key && (
            <div className="flex justify-center">
              <Turnstile
                ref={turnstileRef}
                siteKey={config.turnstile_site_key}
                onSuccess={(token) => setCaptchaToken(token)}
                onExpire={() => setCaptchaToken(null)}
                onError={() => setCaptchaToken(null)}
              />
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Main form ─────────────────────────────────────────────────────────────────

  // Buttons are disabled only until a plan is selected; captcha errors surface inline
  const formReady = !!selectedPlanId
  const isPending = step === 'pending'

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 max-w-lg w-full">
        {sandbox && (
          <button
            type="button"
            onClick={() => navigate({ to: '/client/profile' })}
            className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 cursor-pointer bg-transparent border-0 p-0 mb-4 transition-colors"
          >
            <MdArrowBack className="text-base" /> Back to profile
          </button>
        )}
        {showCardForm ? (
          <>
            <CheckoutBackButton onClick={() => { setShowCardForm(false); setError(null) }} disabled={isPending} />

            {selectedPlan && (
              <div className="border border-gray-200 rounded-xl px-4 py-3 flex items-center justify-between mt-4">
                <span className="text-sm font-medium text-gray-800">{selectedPlan.label} deposit</span>
                <span className="text-sm font-semibold text-gray-800">{depositDisplay(selectedPlan, storageType)}</span>
              </div>
            )}

            {error && <p className="text-sm text-red-500 mt-4">{error}</p>}

            {config?.paypal_client_id && (
              <div className="mt-4">
                <HostedCardFields
                  clientId={config.paypal_client_id}
                  currency={config.paypal_currency || 'USD'}
                  createOrder={createCardOrder}
                  onApprove={handleDepositApprove}
                  onError={(msg) => setError(msg)}
                  disabled={isPending}
                  submitLabel={`Pay by Card${selectedPlan ? ` — ${depositDisplay(selectedPlan, storageType)}` : ''}`}
                />
              </div>
            )}
            <p className="text-[11px] text-gray-400 text-center m-0 mt-3">
              Payments are processed securely by PayPal. Card details are entered directly into
              PayPal and never touch our servers.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-xl font-semibold text-gray-900 m-0">Request access</h1>
              {sandbox && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                  <MdScience className="text-sm" /> Sandbox Payment
                </span>
              )}
            </div>
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
                <p className="text-xs text-gray-400 m-0 mt-1">
                  Not sure how much you'll need? Additional capacity can be purchased once your account is provisioned.
                </p>
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
                {config?.paypal_client_id && (
                  <PayPalCheckoutOptions
                    clientId={config.paypal_client_id}
                    currency={config.paypal_currency || 'USD'}
                    environment={config.paypal_environment === 'sandbox' ? 'sandbox' : 'live'}
                    getClientToken={async () => (await getPublicPayPalClientToken()).client_token}
                    amount={() => (selectedPlan ? depositAmt(selectedPlan, storageType) : '0.00')}
                    createOrder={handleCreateOrder}
                    getApprovalUrl={handleGetApprovalUrl}
                    onApprove={handleDepositApprove}
                    onError={(msg) => setError(msg)}
                    canPay={formReady && !isPending}
                    onChooseCard={handleChooseCard}
                    showApplePay={!sandbox}
                  />
                )}

                {!formReady && !error && (
                  <p className="text-xs text-gray-400 text-center">
                    Select a plan to enable payment.
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
