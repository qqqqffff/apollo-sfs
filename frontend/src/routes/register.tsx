import { createFileRoute, useNavigate, Link } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PayPalScriptProvider, PayPalButtons } from '@paypal/react-paypal-js'
import { Turnstile } from '@marsidev/react-turnstile'
import type { TurnstileInstance } from '@marsidev/react-turnstile'
import { MdCloud, MdRocketLaunch, MdCheckCircle, MdSpeed, MdCheck, MdClose } from 'react-icons/md'
import { register, validateInviteToken } from '../api/auth'
import { ApiError } from '../api/client'
import { publicConfigQueryOptions } from '../api/interest'
import { createPremiumSubscription, confirmPremiumSubscription, type PremiumPlan } from '../api/payments'
import { TermsOfServiceModal } from '../components/TermsOfServiceModal'
import { PremiumPlanSelector } from '../components/PremiumPlanSelector'

// This inline checkout deliberately keeps the popup-based <PayPalButtons>
// (rather than PayPalWalletRedirectButton/PayPalSubscribeButton's redirect
// flow) because it runs on the registration wizard's "plan" step, before the
// SPA has done its Keycloak login — only the backend session cookie exists
// at this point (see the comment below). A redirect would land back on
// /premium, which sits behind the _auth layout's Keycloak gate and would
// bounce the user to a login wall instead of showing the confirmation.
// Known trade-off: this one instance keeps the Chrome-iOS popup bug (see
// PayPalWalletRedirectButton) until it gets its own return route.
function InlinePayPalSubscribeButton({
  clientId, createSubscription, onApprove, onError, onCancel, disabled,
}: {
  clientId: string
  createSubscription: () => Promise<string>
  onApprove: (subscriptionId: string) => Promise<void> | void
  onError: (message: string) => void
  onCancel?: () => void
  disabled?: boolean
}) {
  return (
    <div className={disabled ? 'opacity-50 pointer-events-none' : ''}>
      <PayPalScriptProvider options={{ clientId, intent: 'subscription', vault: true, components: 'buttons' }}>
        <PayPalButtons
          disabled={disabled}
          style={{ layout: 'vertical', shape: 'rect', label: 'subscribe' }}
          createSubscription={() => createSubscription()}
          onApprove={async (data) => { if (data.subscriptionID) await onApprove(data.subscriptionID) }}
          onError={(err) => onError(err instanceof Error ? err.message : 'Subscription failed')}
          onCancel={onCancel}
        />
      </PayPalScriptProvider>
      <p className="text-[11px] text-gray-400 text-center m-0 mt-2">
        Payments are processed securely by PayPal.
      </p>
    </div>
  )
}

interface RegisterParams {
  token: string
}

interface PasswordChecks {
  length: boolean
  upper: boolean
  number: boolean
  symbol: boolean
}

function getPasswordChecks(password: string): PasswordChecks {
  return {
    length: password.length >= 8,
    upper: /[A-Z]/.test(password),
    number: /[0-9]/.test(password),
    symbol: /[^A-Za-z0-9]/.test(password),
  }
}

function PasswordCheckItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 text-xs transition-colors ${ok ? 'text-green-600' : 'text-red-500'}`}>
      {ok ? <MdCheck className="shrink-0" /> : <MdClose className="shrink-0" />}
      {label}
    </li>
  )
}

export const Route = createFileRoute('/register')({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): RegisterParams => ({
    token: typeof search.token === 'string' ? search.token : '',
  }),
  beforeLoad: ({ search }) => search,
  loader: ({ context }) => {
    return { token: context.token }
  },
})

function RouteComponent() {
  const queryClient = useQueryClient()
  const { token } = Route.useLoaderData()
  const navigate = useNavigate()

  const { data: invite } = useQuery({
    queryKey: ['invite', token],
    queryFn: () => validateInviteToken(token),
    enabled: !!token,
    retry: false,
  })
  const { data: config } = useQuery(publicConfigQueryOptions)

  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordFocused, setPasswordFocused] = useState(false)
  const [agreedToTerms, setAgreedToTerms] = useState(false)
  const [showTerms, setShowTerms] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<'form' | 'plan'>('form')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileInstance>(null)

  // The invited email is authoritative — lock it to whatever the token
  // resolves to rather than letting the user redirect the invite elsewhere.
  useEffect(() => {
    if (invite?.email) setEmail(invite.email)
  }, [invite?.email])

  const passwordChecks = getPasswordChecks(password)
  const captchaRequired = !!config?.turnstile_site_key

  // Inline premium checkout on the plan step. Registration auto-logs-in (sets
  // the session cookie), so the protected /payments endpoints work here even
  // though the SPA hasn't done its Keycloak login yet.
  const [showPremiumPay, setShowPremiumPay] = useState(false)
  const [premiumPlan, setPremiumPlan] = useState<PremiumPlan>('monthly')
  const [payError, setPayError] = useState<string | null>(null)
  const [paying, setPaying] = useState(false)
  const [paid, setPaid] = useState(false)

  // Each step/sub-screen renders a differently-sized page. Without this, the
  // browser keeps whatever scroll offset the previous screen ended at (e.g.
  // scrolled down to reach the submit button on a small viewport), stranding
  // the new screen's heading and primary actions off-screen above the fold.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [step, paid])

  const premiumPlans = config?.premium_plans ?? []
  const selectedPriceCents = premiumPlans.find((p) => p.plan === premiumPlan)?.price_cents ?? 0
  const premiumPriceLabel = selectedPriceCents ? `$${(selectedPriceCents / 100).toFixed(2)}` : ''

  async function handleCreatePremiumSubscription(): Promise<string> {
    setPayError(null)
    try {
      const { subscription_id } = await createPremiumSubscription(premiumPlan)
      return subscription_id
    } catch (err) {
      setPayError(err instanceof ApiError ? err.message : 'Could not start checkout')
      throw err
    }
  }

  async function handlePremiumApprove(subscriptionId: string) {
    setPaying(true)
    setPayError(null)
    try {
      await confirmPremiumSubscription(subscriptionId)
      setPaid(true)
    } catch (err) {
      setPayError(err instanceof ApiError ? err.message : 'Subscription could not be confirmed — please try again.')
    } finally {
      setPaying(false)
    }
  }

  const mutation = useMutation({
    mutationFn: () => register(username, email, password, token, captchaToken!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      setStep('plan')
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Registration failed')
      turnstileRef.current?.reset()
      setCaptchaToken(null)
    },
  })

  if (!token) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-start sm:items-center justify-center px-4 py-8">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-sm text-gray-600">
          Invalid or missing invite link.
        </div>
      </div>
    )
  }

  if (step === 'plan') {
    const goToLogin = () => navigate({ to: '/login', search: { social_error: undefined, link_provider: undefined, link_email: undefined, link_username: undefined } })

    if (paid) {
      return (
        <div className="min-h-screen bg-gray-50 flex items-start sm:items-center justify-center px-4 py-8">
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 max-w-md w-full text-center">
            <MdCheckCircle className="text-5xl text-green-500 mx-auto mb-3" />
            <h1 className="text-xl font-semibold text-gray-900 m-0">Premium unlocked.</h1>
            <p className="text-sm text-gray-500 mt-2">
              Your payment went through and Premium is active on your account. Log in to start
              using the SFS API and create per-directory API keys.
            </p>
            <button
              onClick={goToLogin}
              className="mt-6 px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
            >
              Go to login
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="min-h-screen bg-gray-50 flex items-start sm:items-center justify-center px-4 py-8 sm:py-12">
        <div className="w-full max-w-2xl flex flex-col gap-6">
          <div className="text-center">
            <h1 className="text-2xl font-semibold text-gray-900 m-0">Welcome aboard.</h1>
            <p className="text-sm text-gray-500 mt-2">Pick a plan to get started. You can upgrade later from your profile.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button
              onClick={goToLogin}
              className="flex flex-col items-start gap-3 p-6 rounded-xl border border-gray-200 bg-white hover:border-blue-300 hover:shadow-sm cursor-pointer transition-all text-left"
            >
              <MdCloud className="text-3xl text-blue-400" />
              <div>
                <h2 className="text-base font-semibold text-gray-900 m-0">Continue with Free</h2>
                <p className="text-sm text-gray-500 m-0 mt-1">Use the web UI to upload, browse, and share — all the storage your invitation allocated.</p>
              </div>
              <span className="text-xs font-medium text-gray-400 mt-auto">→ Go to login</span>
            </button>
            <button
              onClick={() => setShowPremiumPay(true)}
              className={`flex flex-col items-start gap-3 p-6 rounded-xl border-2 hover:shadow-sm cursor-pointer transition-all text-left ${
                showPremiumPay ? 'border-amber-400 bg-amber-50' : 'border-amber-300 bg-amber-50 hover:border-amber-400'
              }`}
            >
              <MdRocketLaunch className="text-3xl text-amber-500" />
              <div>
                <h2 className="text-base font-semibold text-gray-900 m-0">
                  Upgrade to Premium{premiumPriceLabel ? ` — ${premiumPriceLabel}` : ''}
                </h2>
                <p className="text-sm text-gray-500 m-0 mt-1">Adds the SFS S3-compatible API and per-directory API keys. Recurring subscription, cancel anytime.</p>
              </div>
              <span className="text-xs font-medium text-amber-600 mt-auto">
                {showPremiumPay ? '↓ Pay below' : '→ Pay now'}
              </span>
            </button>
          </div>

          {/* Drive speed benchmark promo */}
          <Link
            to="/blog/drive-speed-benchmark"
            className="flex items-center gap-3 px-5 py-3.5 rounded-xl border border-gray-200 bg-white hover:border-blue-300 hover:shadow-sm cursor-pointer transition-all no-underline max-w-md w-full mx-auto"
          >
            <MdSpeed className="text-xl text-blue-500 shrink-0" />
            <span className="text-sm text-gray-600">
              <span className="font-medium text-gray-800">Curious how fast our storage is?</span>{' '}
              See our fast vs. standard tier speed benchmark →
            </span>
          </Link>

          {/* Inline premium checkout: plan selector + PayPal subscribe button.
              Same flow/styling as the premium upgrade modal. */}
          {showPremiumPay && (
            config?.paypal_client_id ? (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 flex flex-col gap-3 max-w-md w-full mx-auto">
                <h3 className="text-sm font-semibold text-gray-900 m-0">
                  Subscribe to Premium{premiumPriceLabel ? ` — ${premiumPriceLabel}` : ''}
                </h3>
                {payError && <p className="text-sm text-red-500 m-0">{payError}</p>}
                <PremiumPlanSelector plans={premiumPlans} selected={premiumPlan} onSelect={setPremiumPlan} disabled={paying} />
                <InlinePayPalSubscribeButton
                  clientId={config.paypal_client_id}
                  createSubscription={handleCreatePremiumSubscription}
                  onApprove={handlePremiumApprove}
                  onError={(msg) => setPayError(msg)}
                  onCancel={() => setPayError(null)}
                  disabled={paying}
                />
              </div>
            ) : (
              <p className="text-sm text-red-500 text-center m-0">Payments are not configured.</p>
            )
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-start sm:items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm bg-white rounded-xl border border-gray-200 shadow-sm p-6 sm:p-8">
        <div className="flex items-center gap-2 mb-6">
          <h1 className="text-xl font-semibold text-gray-900">Create account</h1>
          {invite?.grant_admin && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
              Admin
            </span>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            mutation.mutate()
          }}
          className="flex flex-col gap-4"
        >
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-gray-700">Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-gray-700">Email</span>
            <input
              type="email"
              value={email}
              readOnly
              autoComplete="email"
              required
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-500 cursor-not-allowed focus:outline-none"
            />
            <span className="text-xs text-gray-400">
              This invitation is tied to the email above and can't be changed here. If this is not
              the correct email please contact us at{' '}
              <a
                href="mailto:support@apollo-sfs.com"
                className="text-blue-600 hover:text-blue-800 transition-colors"
              >
                Apollo SFS support
              </a>
              .
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-gray-700">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={() => setPasswordFocused(true)}
              onBlur={() => setPasswordFocused(false)}
              autoComplete="new-password"
              minLength={8}
              required
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            {passwordFocused && (
              <ul className="space-y-1 pl-0.5 mt-1">
                <PasswordCheckItem ok={passwordChecks.length} label="At least 8 characters" />
                <PasswordCheckItem ok={passwordChecks.upper} label="One uppercase letter" />
                <PasswordCheckItem ok={passwordChecks.number} label="One number" />
                <PasswordCheckItem ok={passwordChecks.symbol} label="One symbol" />
              </ul>
            )}
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={agreedToTerms}
              onChange={(e) => setAgreedToTerms(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 accent-blue-600 cursor-pointer"
              required
            />
            <span className="text-sm text-gray-600">
              I agree to the{' '}
              <button
                type="button"
                onClick={() => setShowTerms(true)}
                className="text-blue-600 hover:underline cursor-pointer"
              >
                Terms of Service
              </button>
            </span>
          </label>
          {config?.turnstile_site_key && (
            <div className="flex justify-center">
              {/* "compact" (150px min-width) instead of the default "normal"
                  (300px min-width) — the card's content area on narrow phones
                  (~295px) is narrower than "normal"/"flexible" ever go, which
                  forced the widget past the card edge and threw the whole
                  page's horizontal centering off. */}
              <Turnstile
                ref={turnstileRef}
                siteKey={config.turnstile_site_key}
                options={{ size: 'compact' }}
                onSuccess={(token) => setCaptchaToken(token)}
                onExpire={() => setCaptchaToken(null)}
                onError={() => setCaptchaToken(null)}
              />
            </div>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={mutation.isPending || !agreedToTerms || (captchaRequired && !captchaToken)}
            className="mt-1 bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50 cursor-pointer transition-colors"
          >
            {mutation.isPending ? 'Creating account…' : 'Create account'}
          </button>
        </form>
      </div>
      {showTerms && <TermsOfServiceModal onClose={() => setShowTerms(false)} />}
    </div>
  )
}
