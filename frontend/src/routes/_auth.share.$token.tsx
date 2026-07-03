import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { resolveShareToken } from '../api/shares'
import { ApiError } from '../api/client'

// Share-link landing page. Lives under the _auth layout so an anonymous
// visitor is sent to login first — the share resolves only after they prove
// they own the recipient email by signing in. On success we hop to the share
// view; on failure we explain why.
export const Route = createFileRoute('/_auth/share/$token')({
  component: RouteComponent,
})

function RouteComponent() {
  const { token } = Route.useParams()
  const navigate = useNavigate()

  const { data: share, isLoading, error } = useQuery({
    queryKey: ['shares', 'resolve', token] as const,
    queryFn: () => resolveShareToken(token),
    retry: false,
  })

  useEffect(() => {
    if (share) {
      navigate({
        to: '/client/shared/$shareId',
        params: { shareId: share.id },
        search: { folder: undefined, file: undefined },
        replace: true,
      })
    }
  }, [share, navigate])

  if (isLoading || share) return <p className="text-sm text-gray-500">Opening shared item…</p>

  const status = error instanceof ApiError ? error.status : 0

  return (
    <div className="flex flex-col items-center py-16 gap-3 text-center">
      <h2 className="text-lg font-semibold text-gray-900 m-0">
        {status === 403 ? 'This share belongs to a different account' : 'Share not found'}
      </h2>
      <p className="text-sm text-gray-500 max-w-sm">
        {status === 403
          ? 'The item was shared with a specific email address. Sign in with the account that received the share email to open it.'
          : 'The link may have been revoked by the owner, expired, or never existed.'}
      </p>
      <button
        onClick={() => navigate({ to: '/client', search: { file: undefined, folder: undefined } })}
        className="text-sm text-blue-600 hover:text-blue-700 bg-transparent border-0 cursor-pointer"
      >
        Go to my files
      </button>
    </div>
  )
}
