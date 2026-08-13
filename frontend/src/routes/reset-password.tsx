import { useState } from 'react'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { MdCheck, MdCheckCircle, MdClose, MdErrorOutline, MdLockReset } from 'react-icons/md'
import { AppIcon } from '../components/AppIcon'
import { resetPassword } from '../api/auth'
import { getPasswordChecks, PASSWORD_CHECK_LABELS } from '../utils/passwordPolicy'

// Landing page for the forgot-password email. The emailed link carries a
// single-use token issued by POST /auth/forgot_password; this page collects the
// new password and hands both to POST /auth/reset_password, which sets it via
// the Keycloak Admin API.
//
// The whole flow deliberately stays on this origin: Keycloak's own
// execute-actions-email would have mailed a link to its password form on
// auth.apollo-sfs.com, dropping the user onto unbranded Keycloak UI.
export const Route = createFileRoute('/reset-password')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  component: RouteComponent,
})

// /login declares its search params, so navigating there has to name them all.
const LOGIN_SEARCH = {
  social_error: undefined,
  link_provider: undefined,
  link_email: undefined,
  link_username: undefined,
} as const

// Same checklist as /register and the signed-in change-password page — the
// rules come from utils/passwordPolicy, which mirrors the Keycloak realm policy.
function CheckItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 text-xs transition-colors ${ok ? 'text-green-600' : 'text-red-500'}`}>
      {ok ? <MdCheck className="shrink-0" /> : <MdClose className="shrink-0" />}
      {label}
    </li>
  )
}

function getChecks(newPassword: string, confirm: string) {
  return {
    ...getPasswordChecks(newPassword),
    match: newPassword.length > 0 && newPassword === confirm,
  }
}

function RouteComponent() {
  const { token } = useSearch({ from: '/reset-password' })
  const navigate = useNavigate()
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [done, setDone] = useState(false)

  const checks = getChecks(newPassword, confirmPassword)
  const allValid = Object.values(checks).every(Boolean)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!token) return
    setTouched(true)
    if (!checks.match) {
      setError('Passwords do not match.')
      return
    }
    if (!allValid) {
      setError('Please satisfy every password requirement below.')
      return
    }
    setIsPending(true)
    try {
      await resetPassword(token, newPassword)
      setDone(true)
    } catch {
      setError('This reset link is invalid or has expired. Request a new one from the sign-in page.')
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div className="flex-1 bg-gray-50 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8">
          <div className="flex justify-center mb-4"><AppIcon /></div>

          {!token && (
            <div className="text-center space-y-3">
              <MdErrorOutline className="text-red-500 text-3xl mx-auto" />
              <h1 className="text-lg font-semibold text-gray-900 m-0">Reset link incomplete</h1>
              <p className="text-sm text-gray-500 m-0">
                This link is missing its reset token. Open the link from your email again, or request
                a new one.
              </p>
              <button
                onClick={() => navigate({ to: '/login', search: LOGIN_SEARCH })}
                className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-6 py-2 text-sm font-medium cursor-pointer transition-colors"
              >
                Back to sign in
              </button>
            </div>
          )}

          {token && done && (
            <div className="text-center space-y-3">
              <MdCheckCircle className="text-green-500 text-3xl mx-auto" />
              <h1 className="text-lg font-semibold text-gray-900 m-0">Password updated</h1>
              <p className="text-sm text-gray-500 m-0">
                Your password has been changed. You can sign in with it now.
              </p>
              <button
                onClick={() => navigate({ to: '/login', search: LOGIN_SEARCH })}
                className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-6 py-2 text-sm font-medium cursor-pointer transition-colors"
              >
                Sign in
              </button>
            </div>
          )}

          {token && !done && (
            <>
              <div className="flex items-center gap-2 mb-1">
                <MdLockReset className="text-blue-600 text-xl" />
                <h1 className="text-lg font-semibold text-gray-900 m-0">Set a new password</h1>
              </div>
              <p className="text-sm text-gray-500 mb-5">
                Choose a new password for your account.
              </p>
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-gray-700">New password</span>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    onFocus={() => setTouched(true)}
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

                {touched && (
                  <ul className="space-y-1 pl-0.5">
                    {PASSWORD_CHECK_LABELS.map(([key, label]) => (
                      <CheckItem key={key} ok={checks[key]} label={label} />
                    ))}
                    <CheckItem ok={checks.match} label="Passwords match" />
                  </ul>
                )}

                {error && <p className="text-sm text-red-500">{error}</p>}

                <button
                  type="submit"
                  disabled={isPending}
                  className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50 cursor-pointer transition-colors"
                >
                  {isPending ? 'Updating…' : 'Update password'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
