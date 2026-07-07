import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MdCloud, MdRocketLaunch, MdCheckCircle } from 'react-icons/md'
import { register, validateInviteToken } from '../api/auth'
import { ApiError } from '../api/client'
import { publicConfigQueryOptions } from '../api/interest'
import { createPaymentOrder, capturePaymentOrder } from '../api/payments'
import { TermsOfServiceModal } from '../components/TermsOfServiceModal'
import { HostedCardFields } from '../components/HostedCardFields'

interface RegisterParams {
  token: string
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
  const [agreedToTerms, setAgreedToTerms] = useState(false)
  const [showTerms, setShowTerms] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<'form' | 'plan'>('form')

  // Inline premium checkout on the plan step. Registration auto-logs-in (sets
  // the session cookie), so the protected /payments endpoints work here even
  // though the SPA hasn't done its Keycloak login yet.
  const [showPremiumPay, setShowPremiumPay] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)
  const [paying, setPaying] = useState(false)
  const [paid, setPaid] = useState(false)

  const premiumPriceCents = config?.premium_price_cents ?? 0
  const premiumPriceLabel = premiumPriceCents ? `$${(premiumPriceCents / 100).toFixed(2)}` : ''

  async function createPremiumCardOrder(): Promise<string> {
    const { order_id } = await createPaymentOrder('card')
    return order_id
  }

  async function handlePremiumCardApprove(orderId: string) {
    setPaying(true)
    setPayError(null)
    try {
      await capturePaymentOrder(orderId)
      setPaid(true)
    } catch (err) {
      setPayError(err instanceof ApiError ? err.message : 'Payment could not be completed — please try again.')
    } finally {
      setPaying(false)
    }
  }

  const mutation = useMutation({
    mutationFn: () => register(username, email, password, token),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      setStep('plan')
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Registration failed')
    },
  })

  if (!token) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
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
        <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
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
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
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
                <p className="text-sm text-gray-500 m-0 mt-1">Adds the SFS S3-compatible API and per-directory API keys. One-time payment.</p>
              </div>
              <span className="text-xs font-medium text-amber-600 mt-auto">
                {showPremiumPay ? '↓ Pay below' : '→ Pay now'}
              </span>
            </button>
          </div>

          {/* Inline premium checkout: Google Pay + PCI-compliant hosted card fields. */}
          {showPremiumPay && (
            config?.paypal_client_id ? (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 flex flex-col gap-3 max-w-md w-full mx-auto">
                <h3 className="text-sm font-semibold text-gray-900 m-0">
                  Pay for Premium{premiumPriceLabel ? ` — ${premiumPriceLabel}` : ''}
                </h3>
                {payError && <p className="text-sm text-red-500 m-0">{payError}</p>}
                <HostedCardFields
                  clientId={config.paypal_client_id}
                  currency={config.paypal_currency || 'USD'}
                  createOrder={createPremiumCardOrder}
                  onApprove={handlePremiumCardApprove}
                  onError={(msg) => setPayError(msg)}
                  disabled={paying}
                  submitLabel={`Pay by Card${premiumPriceLabel ? ` — ${premiumPriceLabel}` : ''}`}
                  googlePayAmount={() => (premiumPriceCents / 100).toFixed(2)}
                />
                <p className="text-[11px] text-gray-400 text-center m-0">
                  Payments are processed securely by PayPal. Card details are entered directly into
                  PayPal and never touch our servers.
                </p>
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
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-white rounded-xl border border-gray-200 shadow-sm p-8">
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
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-gray-700">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
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
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={mutation.isPending || !agreedToTerms}
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
