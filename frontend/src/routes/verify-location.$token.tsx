import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { MdCheckCircle, MdErrorOutline, MdLogin, MdShield } from 'react-icons/md'
import { AppIcon } from '../components/AppIcon'
import { verifyFileServerLocation } from '../api/fileServerLinks'
import { ApiError } from '../api/client'

// Landing page for the enhanced-security verification emails sent when a
// file-server mount link is used from a new (or expired) location. The API
// call requires an authenticated session — being signed in is the second
// factor — so a signed-out visitor is prompted to sign in and reopen the
// email link.
export const Route = createFileRoute('/verify-location/$token')({
  component: RouteComponent,
})

type Phase = 'verifying' | 'verified' | 'unauthenticated' | 'invalid' | 'error'

function RouteComponent() {
  const { token } = Route.useParams()
  const navigate = useNavigate()
  const [phase, setPhase] = useState<Phase>('verifying')
  const attempted = useRef(false)

  useEffect(() => {
    if (attempted.current) return
    attempted.current = true
    verifyFileServerLocation(token)
      .then(() => setPhase('verified'))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) setPhase('unauthenticated')
        else if (err instanceof ApiError && err.status === 404) setPhase('invalid')
        else setPhase('error')
      })
  }, [token])

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm max-w-sm w-full px-6 py-8 text-center space-y-4">
        <div className="flex justify-center"><AppIcon /></div>

        {phase === 'verifying' && (
          <>
            <MdShield className="text-blue-500 text-3xl mx-auto" />
            <h1 className="text-base font-semibold text-gray-900 m-0">Verifying location…</h1>
            <p className="text-xs text-gray-500 m-0">One moment.</p>
          </>
        )}

        {phase === 'verified' && (
          <>
            <MdCheckCircle className="text-green-500 text-3xl mx-auto" />
            <h1 className="text-base font-semibold text-gray-900 m-0">Location verified</h1>
            <p className="text-xs text-gray-500 m-0">
              Uploads and downloads from this location are now allowed for the next 30 days.
              You can retry the transfer on your mounted drive.
            </p>
          </>
        )}

        {phase === 'unauthenticated' && (
          <>
            <MdLogin className="text-amber-500 text-3xl mx-auto" />
            <h1 className="text-base font-semibold text-gray-900 m-0">Sign in required</h1>
            <p className="text-xs text-gray-500 m-0">
              Signing in is the second factor for this verification. Sign in to your
              Apollo SFS account, then open the link from the email again.
            </p>
            <button
              onClick={() => navigate({ to: '/login', search: { social_error: undefined, link_provider: undefined, link_email: undefined, link_username: undefined } })}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg cursor-pointer transition-colors"
            >
              Go to sign in
            </button>
          </>
        )}

        {phase === 'invalid' && (
          <>
            <MdErrorOutline className="text-red-500 text-3xl mx-auto" />
            <h1 className="text-base font-semibold text-gray-900 m-0">Link invalid or expired</h1>
            <p className="text-xs text-gray-500 m-0">
              This verification link is no longer valid — it may have expired (links last
              24 hours), already been used, or belong to a different account. Retry the
              transfer on your mounted drive to receive a fresh email.
            </p>
          </>
        )}

        {phase === 'error' && (
          <>
            <MdErrorOutline className="text-red-500 text-3xl mx-auto" />
            <h1 className="text-base font-semibold text-gray-900 m-0">Something went wrong</h1>
            <p className="text-xs text-gray-500 m-0">Please try the link again in a moment.</p>
          </>
        )}
      </div>
    </div>
  )
}
