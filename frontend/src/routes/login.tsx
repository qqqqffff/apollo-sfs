import { useState, useEffect, useCallback } from 'react'
import { createFileRoute, redirect, useNavigate, useSearch } from '@tanstack/react-router'
import { MdClose } from 'react-icons/md'
import { useAuth } from '../auth'
import { forgotPassword, resetPassword } from '../api/auth'
import { post } from '../api/client'

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>) => ({
    social_error:   typeof search.social_error   === 'string' ? search.social_error   : undefined,
    link_provider:  typeof search.link_provider  === 'string' ? search.link_provider  : undefined,
    link_email:     typeof search.link_email     === 'string' ? search.link_email     : undefined,
    link_username:  typeof search.link_username  === 'string' ? search.link_username  : undefined,
  }),
  beforeLoad: async ({ context }) => {
    const result = await context.auth.validateAuth()
    if (result && result !== 'banned' && result !== 'suspended') {
      throw redirect({
        to: '/client',
        search: {
          file: undefined,
          folder: undefined
        }
      })
    }
  },
  component: RouteComponent,
})

const KC_REALM = 'apollo-sfs-realm'
const KC_CLIENT_ID = 'apollo-sfs-api'
// Keycloak runs on its own hostname (see nginx auth.apollo-sfs.com vhost). The
// browser is redirected here to start the OIDC code flow; the callback returns
// to this app's own origin (redirect_uri below).
const KC_BASE_URL = 'https://auth.apollo-sfs.com'

function socialLoginUrl(provider: 'google' | 'apple') {
  const params = new URLSearchParams({
    client_id: KC_CLIENT_ID,
    redirect_uri: `${window.location.origin}/api/v1/auth/social/callback`,
    response_type: 'code',
    scope: 'openid',
    kc_idp_hint: provider,
    state: provider, // echoed back by KC so the callback knows which provider returned
  })
  return `${KC_BASE_URL}/realms/${KC_REALM}/protocol/openid-connect/auth?${params}`
}

const SOCIAL_ERROR_MESSAGES: Record<string, string> = {
  access_denied:    'Sign-in was cancelled.',
  exchange_failed:  'Could not complete sign-in. Please try again.',
  session_failed:   'Could not create session. Please try again.',
  missing_code:     'Sign-in failed. Please try again.',
}

function RouteComponent() {
  const navigate = useNavigate()
  const { social_error, link_provider, link_email, link_username } = useSearch({ from: '/login' })
  const { login } = useAuth()
  const [showForgot, setShowForgot] = useState(false)

  const socialErrorMessage = social_error
    ? (SOCIAL_ERROR_MESSAGES[social_error] ?? 'Sign-in failed. Please try again.')
    : null

  return (
    <div className="flex-1 bg-gray-50 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8">
          {link_provider && link_email ? (
            <LinkAccountForm
              provider={link_provider}
              email={link_email}
              existingUsername={link_username}
            />
          ) : (
            <>
              <h1 className="text-xl font-semibold text-gray-900 mb-6">Sign in</h1>

              {socialErrorMessage && (
                <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                  {socialErrorMessage}
                </p>
              )}

              <SignInForm
                onSuccess={(role) => {
                  if (role === 'admin') navigate({ to: '/admin/users' })
                  else navigate({ to: '/client', search: { file: undefined, folder: undefined } })
                }}
                login={login}
                onForgot={() => setShowForgot(true)}
              />

              <div className="mt-6 flex items-center gap-3">
                <div className="flex-1 h-px bg-gray-200" />
                <span className="text-xs text-gray-400">or continue with</span>
                <div className="flex-1 h-px bg-gray-200" />
              </div>

              <div className="mt-4 flex flex-col gap-3">
                <a
                  href={socialLoginUrl('google')}
                  className="flex items-center justify-center gap-2.5 px-4 py-2 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-sm font-medium text-gray-700 transition-colors no-underline"
                >
                  <GoogleIcon className="w-4 h-4 shrink-0" />
                  Sign in with Google
                </a>
                <AppleSignInButton />
              </div>
            </>
          )}
        </div>
      </div>

      {showForgot && <ForgotPasswordModal onClose={() => setShowForgot(false)} />}
    </div>
  )
}

// ── Sign-in form ──────────────────────────────────────────────────────────────

interface SignInFormProps {
  onSuccess: (role: 'admin' | 'client') => void
  login: (u: string, p: string) => Promise<'fail' | 'admin' | 'client' | 'nextStep' | 'banned' | 'suspended'>
  onForgot: () => void
}

function SignInForm({ onSuccess, login, onForgot }: SignInFormProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setIsPending(true)
    const result = await login(username, password)
    setIsPending(false)
    if (result === 'admin' || result === 'client') {
      onSuccess(result)
    } else {
      setError('Invalid username or password')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-gray-700">Username</span>
        <input
          tabIndex={1}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-gray-700">Password</span>
        <input
          tabIndex={2}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </label>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <button
        tabIndex={3}
        type="submit"
        disabled={isPending}
        className="mt-1 bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50 cursor-pointer transition-colors"
      >
        {isPending ? 'Signing in…' : 'Sign in'}
      </button>
      <button
        tabIndex={4}
        type="button"
        onClick={onForgot}
        className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer bg-transparent border-0 p-0 transition-colors text-center"
      >
        Forgot password?
      </button>
    </form>
  )
}

// ── Link account form ─────────────────────────────────────────────────────────

const PROVIDER_LABEL: Record<string, string> = { google: 'Google', apple: 'Apple' }

interface LinkAccountFormProps {
  provider: string
  email: string
  existingUsername?: string
}

function LinkAccountForm({ provider, email, existingUsername }: LinkAccountFormProps) {
  const navigate = useNavigate()
  const [username, setUsername] = useState(existingUsername ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)

  const providerLabel = PROVIDER_LABEL[provider] ?? provider

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setIsPending(true)
    try {
      await post('/auth/social/link', { username, password })
      navigate({ to: '/client', search: { file: undefined, folder: undefined } })
    } catch {
      setError('Incorrect username or password. Please try again.')
    } finally {
      setIsPending(false)
    }
  }

  return (
    <>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-gray-900 mb-1">Link your account</h1>
        <p className="text-sm text-gray-500">
          An account with <span className="font-medium text-gray-700">{email}</span> already
          exists. Enter your password to link it with {providerLabel} for future sign-ins.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
          <span className="text-sm font-medium text-gray-700">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            autoFocus
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </label>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={isPending}
          className="mt-1 bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50 cursor-pointer transition-colors"
        >
          {isPending ? 'Linking…' : `Link account & sign in`}
        </button>
      </form>

      <p className="mt-4 text-xs text-gray-400 text-center">
        Not you?{' '}
        <a href="/login" className="text-blue-600 hover:text-blue-800">
          Back to sign in
        </a>
      </p>
    </>
  )
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  )
}

function AppleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.7 9.05 7.38c1.27.07 2.14.74 2.87.78 1.09-.21 2.13-.91 3.29-.84 1.39.1 2.44.63 3.13 1.57-2.87 1.72-2.19 5.45.37 6.59-.57 1.52-1.33 3.02-1.66 4.8zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  )
}

// ── Sign in with Apple (JS SDK — iOS / macOS only) ────────────────────────────

const APPLE_SERVICE_ID = import.meta.env.VITE_APPLE_SERVICE_ID as string | undefined
const APPLE_SDK_URL = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js'

function isAppleDevice(): boolean {
  return /iPhone|iPad|iPod|Macintosh/i.test(navigator.userAgent)
}

interface AppleConflict {
  link_provider: string
  link_email: string
  link_username?: string
}

function AppleSignInButton() {
  const navigate = useNavigate()
  const [sdkReady, setSdkReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [conflict, setConflict] = useState<AppleConflict | null>(null)

  const onAppleDevice = isAppleDevice()

  useEffect(() => {
    if (!onAppleDevice || !APPLE_SERVICE_ID) return
    if (window.AppleID) { setSdkReady(true); return }

    const script = document.createElement('script')
    script.src = APPLE_SDK_URL
    script.async = true
    script.onload = () => {
      window.AppleID?.auth.init({
        clientId: APPLE_SERVICE_ID,
        scope: 'name email',
        redirectURI: window.location.origin + '/login',
        usePopup: true,
      })
      setSdkReady(true)
    }
    document.head.appendChild(script)
    return () => { document.head.removeChild(script) }
  }, [onAppleDevice])

  const handleAppleSignIn = useCallback(async () => {
    if (!window.AppleID) return
    setError(null)
    setIsPending(true)
    try {
      const result = await window.AppleID.auth.signIn()
      const res = await post<{ link_required?: boolean; link_provider?: string; link_email?: string; link_username?: string }>(
        '/auth/social/apple',
        { identity_token: result.authorization.id_token },
      )
      if (res.link_required) {
        setConflict({
          link_provider: res.link_provider!,
          link_email: res.link_email!,
          link_username: res.link_username,
        })
      } else {
        navigate({ to: '/client', search: { file: undefined, folder: undefined } })
      }
    } catch (err: unknown) {
      // Apple returns a specific error object when the user cancels
      if (err && typeof err === 'object' && 'error' in err && (err as { error: string }).error === 'popup_closed_by_user') {
        // silently ignore cancellation
      } else {
        setError('Sign in with Apple failed. Please try again.')
      }
    } finally {
      setIsPending(false)
    }
  }, [navigate])

  if (!onAppleDevice || !APPLE_SERVICE_ID) return null

  if (conflict) {
    return (
      <div className="mt-2 p-4 rounded-xl border border-amber-200 bg-amber-50 text-sm">
        <p className="font-medium text-amber-900 mb-1">Account already exists</p>
        <p className="text-amber-700 text-xs mb-3">
          <span className="font-medium">{conflict.link_email}</span> is linked to an existing
          account. Sign in below to connect Apple for future sign-ins.
        </p>
        <LinkAccountForm
          provider={conflict.link_provider}
          email={conflict.link_email}
          existingUsername={conflict.link_username}
        />
      </div>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={handleAppleSignIn}
        disabled={!sdkReady || isPending}
        className="flex items-center justify-center gap-2.5 px-4 py-2 rounded-lg border border-gray-900 bg-gray-900 hover:bg-gray-800 text-sm font-medium text-white transition-colors cursor-pointer disabled:opacity-50 w-full"
      >
        <AppleIcon className="w-4 h-4 shrink-0" />
        {isPending ? 'Signing in…' : 'Sign in with Apple'}
      </button>
      {error && <p className="text-xs text-red-500 text-center">{error}</p>}
    </>
  )
}

// ── Forgot / reset password modal ─────────────────────────────────────────────

type ModalStep = 'request' | 'reset' | 'done'

function ForgotPasswordModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<ModalStep>('request')
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setIsPending(true)
    try {
      await forgotPassword(email)
      setStep('reset')
    } catch {
      setError('Could not send reset email. Please check the address and try again.')
    } finally {
      setIsPending(false)
    }
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    setIsPending(true)
    try {
      await resetPassword(token, newPassword)
      setStep('done')
    } catch {
      setError('Reset failed. The token may be invalid or expired.')
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-sm bg-white rounded-xl border border-gray-200 shadow-xl p-8 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 p-0.5 transition-colors"
          aria-label="Close"
        >
          <MdClose className="text-xl" />
        </button>

        {step === 'request' && (
          <>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Reset your password</h2>
            <p className="text-sm text-gray-500 mb-5">
              Enter your account email and we'll send you a reset link.
            </p>
            <form onSubmit={handleRequest} className="flex flex-col gap-4">
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-gray-700">Email address</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </label>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <button
                type="submit"
                disabled={isPending}
                className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50 cursor-pointer transition-colors"
              >
                {isPending ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          </>
        )}

        {step === 'reset' && (
          <>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Set a new password</h2>
            <p className="text-sm text-gray-500 mb-5">
              Check your email for the reset token, then enter it below along with your new password.
            </p>
            <form onSubmit={handleReset} className="flex flex-col gap-4">
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-gray-700">Reset token</span>
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                  required
                  placeholder="Paste token from email"
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-gray-700">New password</span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-gray-700">Confirm new password</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </label>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <button
                type="submit"
                disabled={isPending}
                className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50 cursor-pointer transition-colors"
              >
                {isPending ? 'Resetting…' : 'Reset password'}
              </button>
              <button
                type="button"
                onClick={() => { setStep('request'); setError(null) }}
                className="text-sm text-gray-500 hover:text-gray-700 cursor-pointer bg-transparent border-0 p-0 text-center transition-colors"
              >
                Didn't get an email? Send again
              </button>
            </form>
          </>
        )}

        {step === 'done' && (
          <div className="flex flex-col items-center text-center gap-4 py-2">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
              <span className="text-green-600 text-2xl font-bold">✓</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-1">Password reset</h2>
              <p className="text-sm text-gray-500">Your password has been updated. You can now sign in.</p>
            </div>
            <button
              onClick={onClose}
              className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-6 py-2 text-sm font-medium cursor-pointer transition-colors"
            >
              Back to sign in
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
