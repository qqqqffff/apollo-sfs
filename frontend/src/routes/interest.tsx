import { createFileRoute } from '@tanstack/react-router'
import { useState, useRef } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Turnstile } from '@marsidev/react-turnstile'
import type { TurnstileInstance } from '@marsidev/react-turnstile'
import { submitInterestForm, publicConfigQueryOptions } from '../api/interest'
import { ApiError } from '../api/client'

export const Route = createFileRoute('/interest')({
  component: RouteComponent,
})

const STORAGE_MIN_GB = 1
const STORAGE_MAX_GB = 100
const STORAGE_STEP = 1

const GB_PRESETS = [1, 5, 10, 25, 50, 100]

function formatGB(gb: number) {
  return `${gb} GB`
}

function RouteComponent() {
  const { data: config } = useQuery(publicConfigQueryOptions)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [storageGB, setStorageGB] = useState(10)
  const [useCase, setUseCase] = useState('')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileInstance>(null)

  const mutation = useMutation({
    mutationFn: () =>
      submitInterestForm({
        name: name.trim(),
        email: email.trim(),
        desired_storage_gb: storageGB,
        use_case: useCase.trim(),
        captcha_token: captchaToken!,
      }),
    onSuccess: () => {
      setSubmitted(true)
      setError(null)
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Something went wrong — please try again.')
      // Reset the widget so the user can retry.
      turnstileRef.current?.reset()
      setCaptchaToken(null)
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!captchaToken) {
      setError('Please complete the security check.')
      return
    }
    setError(null)
    mutation.mutate()
  }

  if (submitted) {
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
            Thanks for your interest in Apollo SFS. We'll be in touch if there's a spot available.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 max-w-lg w-full">
        <h1 className="text-xl font-semibold text-gray-900 mb-1">Request access</h1>
        <p className="text-sm text-gray-500 mb-6">
          Apollo SFS is currently invite-only. Fill out this form and we'll reach out if a spot opens up.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          {/* Name */}
          <div className="flex flex-col gap-1">
            <label htmlFor="name" className="text-sm font-medium text-gray-700">Full name</label>
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
            <label htmlFor="email" className="text-sm font-medium text-gray-700">Email address</label>
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

          {/* Storage slider */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label htmlFor="storage" className="text-sm font-medium text-gray-700">Desired storage</label>
              <span className="text-sm font-semibold text-blue-600">{formatGB(storageGB)}</span>
            </div>
            <input
              id="storage"
              type="range"
              min={STORAGE_MIN_GB}
              max={STORAGE_MAX_GB}
              step={STORAGE_STEP}
              value={storageGB}
              onChange={(e) => setStorageGB(Number(e.target.value))}
              className="w-full accent-blue-600"
            />
            <div className="flex justify-between gap-1 flex-wrap">
              {GB_PRESETS.map((gb) => (
                <button
                  key={gb}
                  type="button"
                  onClick={() => setStorageGB(gb)}
                  className={`flex-1 min-w-8 px-1 py-0.5 text-xs rounded border transition-colors cursor-pointer ${
                    storageGB === gb
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
                  }`}
                >
                  {gb} GB
                </button>
              ))}
            </div>
          </div>

          {/* Use case */}
          <div className="flex flex-col gap-1">
            <label htmlFor="use-case" className="text-sm font-medium text-gray-700">
              Reason / use case
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

          <button
            type="submit"
            disabled={mutation.isPending || !captchaToken}
            className="px-4 py-2.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50 transition-colors cursor-pointer"
          >
            {mutation.isPending ? 'Submitting…' : 'Submit request'}
          </button>
        </form>
      </div>
    </div>
  )
}
