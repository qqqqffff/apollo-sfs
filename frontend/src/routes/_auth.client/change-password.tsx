import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { MdArrowBack, MdCheck, MdClose, MdMarkEmailRead, MdShield } from 'react-icons/md'
import { changePassword, requestPasswordChangeCode } from '../../api/me'
import { ApiError } from '../../api/client'
import { getPasswordChecks, PASSWORD_CHECK_LABELS } from '../../utils/passwordPolicy'

export const Route = createFileRoute('/_auth/client/change-password')({
  component: RouteComponent,
})

function getChecks(newPassword: string, confirm: string) {
  return {
    ...getPasswordChecks(newPassword),
    match: newPassword.length > 0 && newPassword === confirm,
  }
}

function CheckItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 text-xs transition-colors ${ok ? 'text-green-600' : 'text-red-500'}`}>
      {ok ? <MdCheck className="shrink-0" /> : <MdClose className="shrink-0" />}
      {label}
    </li>
  )
}

function RouteComponent() {
  const navigate = useNavigate()

  // Two-step flow: request an emailed code, then submit it with the passwords.
  const [codeSent, setCodeSent] = useState(false)
  const [code, setCode] = useState('')
  const [current, setCurrent] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const checks = getChecks(newPw, confirm)
  const allValid = Object.values(checks).every(Boolean)

  const requestCodeMutation = useMutation({
    mutationFn: requestPasswordChangeCode,
    onSuccess: () => { setCodeSent(true); setError(null) },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to send code'),
  })

  const changeMutation = useMutation({
    mutationFn: () => changePassword(current, newPw, code.trim()),
    onSuccess: () => {
      setDone(true)
      setError(null)
      setCurrent(''); setNewPw(''); setConfirm(''); setCode('')
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to change password'),
  })

  if (done) {
    return (
      <div className="max-w-lg mx-auto">
        <div className="bg-white border border-gray-200 rounded-xl px-6 py-8 flex flex-col items-center text-center gap-3">
          <MdCheck className="text-5xl text-green-500" />
          <h2 className="text-lg font-semibold text-gray-900 m-0">Password changed</h2>
          <p className="text-sm text-gray-500 m-0">Your password has been updated successfully.</p>
          <button
            onClick={() => navigate({ to: '/client/profile' })}
            className="mt-2 px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
          >
            Back to profile
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-lg mx-auto space-y-4">
      <button
        onClick={() => navigate({ to: '/client/profile' })}
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 cursor-pointer bg-transparent border-0 p-0 transition-colors"
      >
        <MdArrowBack className="text-base" /> Back to profile
      </button>

      <h2 className="text-lg font-semibold text-gray-900 m-0">Change password</h2>

      <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
        <div className="flex items-start gap-3 mb-4 pb-4 border-b border-gray-100">
          <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
            <MdShield className="text-blue-600 text-lg" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-800 m-0">Two-factor verification</h3>
            <p className="text-xs text-gray-500 m-0 mt-0.5">
              For your security, changing your password requires a one-time code sent to your
              account's email address.
            </p>
          </div>
        </div>

        {!codeSent ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-gray-600 m-0">
              We'll email a 6-digit code to verify it's you. The code expires in 10 minutes.
            </p>
            {error && <p className="text-xs text-red-500 m-0">{error}</p>}
            <button
              onClick={() => { setError(null); requestCodeMutation.mutate() }}
              disabled={requestCodeMutation.isPending}
              className="self-start inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg disabled:opacity-50 transition-colors cursor-pointer"
            >
              <MdMarkEmailRead className="text-base" />
              {requestCodeMutation.isPending ? 'Sending…' : 'Email me a code'}
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setError(null)
              changeMutation.mutate()
            }}
            className="flex flex-col gap-3"
          >
            <div className="flex items-center gap-2 px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-xs text-green-700">
              <MdMarkEmailRead className="text-base shrink-0" />
              <span className="flex-1">A verification code was sent to your email.</span>
              <button
                type="button"
                onClick={() => requestCodeMutation.mutate()}
                disabled={requestCodeMutation.isPending}
                className="text-green-700 hover:text-green-900 font-medium cursor-pointer bg-transparent border-0 p-0 disabled:opacity-50"
              >
                {requestCodeMutation.isPending ? 'Resending…' : 'Resend'}
              </button>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Verification code</label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => { setCode(e.target.value); setError(null) }}
                placeholder="6-digit code"
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Current password</label>
              <input
                type="password"
                value={current}
                onChange={(e) => { setCurrent(e.target.value); setError(null) }}
                autoComplete="current-password"
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">New password</label>
              <input
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                onFocus={() => setTouched(true)}
                autoComplete="new-password"
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Confirm new password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onFocus={() => setTouched(true)}
                autoComplete="new-password"
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {touched && (
              <ul className="space-y-1 pl-0.5">
                {PASSWORD_CHECK_LABELS.map(([key, label]) => (
                  <CheckItem key={key} ok={checks[key]} label={label} />
                ))}
                <CheckItem ok={checks.match} label="Passwords match" />
              </ul>
            )}

            {error && <p className="text-xs text-red-500">{error}</p>}

            <button
              type="submit"
              disabled={!code.trim() || !current || !allValid || changeMutation.isPending}
              className="self-start px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg disabled:opacity-50 transition-colors cursor-pointer"
            >
              {changeMutation.isPending ? 'Saving…' : 'Update password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
