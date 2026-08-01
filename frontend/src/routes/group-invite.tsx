import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { MdCloud, MdRocketLaunch, MdStorage, MdSpeed, MdHourglassTop, MdBlock } from 'react-icons/md'
import { getGroupInvite, reserveGroupSlot, type RegistrationSlotType } from '../api/registrationGroups'
import { ApiError } from '../api/client'
import { useAuth } from '../auth'
import { AlreadySignedInNotice } from '../components/AlreadySignedInNotice'

interface GroupInviteParams {
  id: string
}

export const Route = createFileRoute('/group-invite')({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): GroupInviteParams => ({
    id: typeof search.id === 'string' ? search.id : '',
  }),
})

const GB = 1024 ** 3

function formatQuota(bytes: number): string {
  if (bytes >= 1024 * GB) return `${(bytes / (1024 * GB)).toFixed(bytes % (1024 * GB) === 0 ? 0 : 1)} TB`
  return `${(bytes / GB).toFixed(bytes % GB === 0 ? 0 : 1)} GB`
}

function RouteComponent() {
  const { id } = Route.useSearch()
  const navigate = useNavigate()
  const { isAuthenticated, isLoading: authLoading, user } = useAuth()
  const [reserveError, setReserveError] = useState<string | null>(null)
  const [pendingSlotId, setPendingSlotId] = useState<string | null>(null)

  const { data: invite, isLoading, error, refetch } = useQuery({
    queryKey: ['group-invite', id],
    queryFn: () => getGroupInvite(id),
    enabled: !!id,
    retry: false,
    // Availability changes as other visitors reserve/complete slots.
    refetchInterval: 10_000,
  })

  const reserveMutation = useMutation({
    mutationFn: (slotId: string) => reserveGroupSlot(id, slotId),
    onMutate: (slotId) => {
      setPendingSlotId(slotId)
      setReserveError(null)
    },
    onSuccess: ({ reservation_token }) => {
      navigate({ to: '/register', search: { token: '', reservation: reservation_token } })
    },
    onError: (err) => {
      setPendingSlotId(null)
      setReserveError(err instanceof ApiError ? err.message : 'Could not reserve this slot — please try again.')
      // The slot may have been taken while the page was idle; refresh counts.
      refetch()
    },
  })

  if (!id) {
    return (
      <PublicShell>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-sm text-gray-600">
          Invalid or missing group invite link.
        </div>
      </PublicShell>
    )
  }

  if (authLoading) {
    return (
      <PublicShell>
        <p className="text-sm text-gray-500">Loading…</p>
      </PublicShell>
    )
  }

  if (isAuthenticated) {
    return (
      <PublicShell>
        <AlreadySignedInNotice username={user?.username} />
      </PublicShell>
    )
  }

  if (isLoading) {
    return (
      <PublicShell>
        <p className="text-sm text-gray-500">Loading invitation…</p>
      </PublicShell>
    )
  }

  if (error || !invite) {
    const message = error instanceof ApiError
      ? error.message
      : 'This registration link could not be loaded.'
    return (
      <PublicShell>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 max-w-md text-center">
          <MdBlock className="text-4xl text-gray-300 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-gray-900 m-0">Registration unavailable</h1>
          <p className="text-sm text-gray-500 mt-2 mb-0">{message}</p>
        </div>
      </PublicShell>
    )
  }

  return (
    <PublicShell>
      <div className="w-full max-w-3xl flex flex-col gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-gray-900 m-0">Join {invite.name}</h1>
          <p className="text-sm text-gray-500 mt-2 mb-0">
            Pick an account slot below to create your Apollo SFS account.
            {invite.expires_at && (
              <> Registration closes on{' '}
                <span className="font-medium text-gray-700">
                  {new Date(invite.expires_at).toLocaleDateString(undefined, { dateStyle: 'long' })}
                </span>.
              </>
            )}
          </p>
        </div>

        {reserveError && (
          <p className="text-sm text-red-500 text-center m-0">{reserveError}</p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {invite.slot_types.map((t) => (
            <SlotCard
              key={t.slot_id}
              type={t}
              pending={pendingSlotId === t.slot_id && reserveMutation.isPending}
              disabled={reserveMutation.isPending}
              onSelect={() => reserveMutation.mutate(t.slot_id)}
            />
          ))}
        </div>

        <p className="text-xs text-gray-400 text-center m-0">
          Selecting a slot holds it for 10 minutes while you complete registration.
        </p>
      </div>
    </PublicShell>
  )
}

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-start sm:items-center justify-center px-4 py-8 sm:py-12">
      {children}
    </div>
  )
}

// ── Slot card ─────────────────────────────────────────────────────────────────

function SlotCard({ type: t, pending, disabled, onSelect }: {
  type: RegistrationSlotType
  pending: boolean
  disabled: boolean
  onSelect: () => void
}) {
  // Unavailable  = every slot of the type is consumed.
  // In progress  = none free right now, but some are only held by other
  //                visitors' 10-minute reservations.
  const unavailable = t.available === 0 && t.reserved === 0
  const inProgress = t.available === 0 && t.reserved > 0
  const selectable = t.available > 0 && !disabled

  const isPremium = t.account_status === 'premium'
  const isFast = t.drive_type === 'nvme'

  return (
    <button
      type="button"
      onClick={() => { if (selectable) onSelect() }}
      disabled={!selectable}
      className={`flex flex-col items-start gap-3 p-6 rounded-xl border-2 text-left transition-all ${
        unavailable || inProgress
          ? 'border-gray-200 bg-white opacity-50 cursor-not-allowed'
          : isPremium
            ? 'border-amber-300 bg-amber-50 hover:border-amber-400 hover:shadow-sm cursor-pointer'
            : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-sm cursor-pointer'
      }`}
    >
      <div className="flex items-center gap-2 w-full">
        {isPremium
          ? <MdRocketLaunch className="text-3xl text-amber-500" />
          : <MdCloud className="text-3xl text-blue-400" />}
        <div className="ml-auto flex items-center gap-1.5">
          {isFast
            ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700"><MdSpeed /> Fast</span>
            : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-500"><MdStorage /> Standard</span>}
        </div>
      </div>

      <div>
        <h2 className="text-base font-semibold text-gray-900 m-0">
          {formatQuota(t.quota_bytes)} · {isPremium ? 'Premium' : 'Base'} account
        </h2>
        <p className="text-sm text-gray-500 m-0 mt-1">
          {formatQuota(t.quota_bytes)} of {isFast ? 'fast NVMe' : 'standard'} storage on{' '}
          <span className="font-medium text-gray-600">{t.server_name}</span>
          {isPremium && (
            t.premium_expires_at
              ? <> — Premium until {new Date(t.premium_expires_at).toLocaleDateString()}</>
              : <> — Premium included</>
          )}
          .
        </p>
      </div>

      <span className="mt-auto text-xs font-medium">
        {unavailable ? (
          <span className="text-gray-400">Unavailable</span>
        ) : inProgress ? (
          <span className="inline-flex items-center gap-1 text-amber-600"><MdHourglassTop /> Registration in progress</span>
        ) : pending ? (
          <span className="text-blue-600">Reserving…</span>
        ) : (
          <span className={isPremium ? 'text-amber-600' : 'text-blue-600'}>
            {t.total > 1 ? `${t.available} available — ` : ''}Select this slot →
          </span>
        )}
      </span>
    </button>
  )
}
