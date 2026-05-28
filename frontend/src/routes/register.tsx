import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MdCloud, MdRocketLaunch } from 'react-icons/md'
import { register, validateInviteToken } from '../api/auth'
import { ApiError } from '../api/client'
import { TermsOfServiceModal } from '../components/TermsOfServiceModal'

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

  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [agreedToTerms, setAgreedToTerms] = useState(false)
  const [showTerms, setShowTerms] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<'form' | 'plan'>('form')

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
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="w-full max-w-2xl flex flex-col gap-6">
          <div className="text-center">
            <h1 className="text-2xl font-semibold text-gray-900 m-0">Welcome aboard.</h1>
            <p className="text-sm text-gray-500 mt-2">Pick a plan to get started. You can upgrade later from your profile.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button
              onClick={() => navigate({ to: '/login' })}
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
              onClick={() => navigate({ to: '/login', search: { redirect: '/premium' } as never })}
              className="flex flex-col items-start gap-3 p-6 rounded-xl border-2 border-amber-300 bg-amber-50 hover:border-amber-400 hover:shadow-sm cursor-pointer transition-all text-left"
            >
              <MdRocketLaunch className="text-3xl text-amber-500" />
              <div>
                <h2 className="text-base font-semibold text-gray-900 m-0">Upgrade to Premium</h2>
                <p className="text-sm text-gray-500 m-0 mt-1">Adds the SFS S3-compatible API and per-directory API keys. One-time payment.</p>
              </div>
              <span className="text-xs font-medium text-amber-600 mt-auto">→ Log in and upgrade</span>
            </button>
          </div>
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
