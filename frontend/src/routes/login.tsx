import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { MdClose } from 'react-icons/md'
import { useAuth } from '../auth'
import { forgotPassword, resetPassword } from '../api/auth'

export const Route = createFileRoute('/login')({
  component: RouteComponent,
})

function RouteComponent() {
  const navigate = useNavigate()
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [showForgot, setShowForgot] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setIsPending(true)
    const result = await login(username, password)
    setIsPending(false)

    if (result === 'admin') {
      navigate({ to: '/admin/users' })
    } else if (result === 'client') {
      navigate({ to: '/client', search: { file: undefined, folder: undefined } })
    } else {
      setError('Invalid username or password')
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-white rounded-xl border border-gray-200 shadow-sm p-8">
        <h1 className="text-xl font-semibold text-gray-900 mb-6">Sign in</h1>
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
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">Password</span>
              <button
                type="button"
                onClick={() => setShowForgot(true)}
                className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer bg-transparent border-0 p-0 transition-colors"
              >
                Forgot password?
              </button>
            </div>
            <input
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
            type="submit"
            disabled={isPending}
            className="mt-1 bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50 cursor-pointer transition-colors"
          >
            {isPending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>

      {showForgot && <ForgotPasswordModal onClose={() => setShowForgot(false)} />}
    </div>
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
