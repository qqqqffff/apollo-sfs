import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { MdCheck, MdRocketLaunch } from 'react-icons/md'
import { createPremiumSubscription, confirmPremiumSubscription, type PremiumPlan } from '../api/payments'
import { meQueryOptions } from '../api/me'
import { useBillingConfig } from '../hooks/useBillingConfig'
import { ApiError } from '../api/client'
import { PayPalSubscribeButton } from '../components/PayPalSubscribeButton'
import { PremiumPlanSelector } from '../components/PremiumPlanSelector'

interface Search {
  status?: 'approved' | 'cancelled'
  subscription_id?: string // PayPal subscription-approval redirect param
}

export const Route = createFileRoute('/_auth/premium')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    status: search.status === 'approved' || search.status === 'cancelled' ? search.status : undefined,
    subscription_id: typeof search.subscription_id === 'string' ? search.subscription_id : undefined,
  }),
  component: RouteComponent,
})

const FEATURES = [
  'SFS S3-compatible API for programmatic access',
  'Per-directory API keys with read / write / delete / list scopes',
  'Share folder URLs from the file browser',
  'Same encryption + storage allocation as the web UI',
  'Cancel anytime from your profile',
]

function RouteComponent() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const search = useSearch({ from: '/_auth/premium' })
  const { data: user } = useQuery(meQueryOptions)
  const { data: config, isLoading: configLoading } = useBillingConfig()
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<PremiumPlan>('monthly')

  const confirm = useMutation({
    mutationFn: (subscriptionId: string) => confirmPremiumSubscription(subscriptionId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      navigate({ to: '/settings/api-keys' as never })
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Confirmation failed'),
  })

  // PayPal redirected back with approval → confirm the grant immediately.
  if (search.status === 'approved' && search.subscription_id && !confirm.isSuccess && !confirm.isPending) {
    confirm.mutate(search.subscription_id)
  }

  async function handleCreateSubscription(): Promise<string> {
    setError(null)
    try {
      const { subscription_id } = await createPremiumSubscription(plan)
      return subscription_id
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start checkout')
      throw err
    }
  }

  function handleApprove(subscriptionId: string) {
    confirm.mutate(subscriptionId)
  }

  if (!user) return <p className="text-sm text-gray-500">Loading…</p>

  if (user.is_premium || user.is_admin) {
    return (
      <div className="max-w-xl mx-auto text-center py-12">
        <MdCheck className="text-5xl text-green-500 mx-auto mb-3" />
        <h1 className="text-xl font-semibold text-gray-900">You&rsquo;re already on Premium.</h1>
        <p className="text-sm text-gray-500 mt-2">
          {user.is_admin
            ? 'Premium is included with admin accounts.'
            : `Granted on ${user.premium_granted_at ? new Date(user.premium_granted_at).toLocaleDateString() : '—'}.`}
        </p>
        <button
          onClick={() => navigate({ to: '/settings/api-keys' as never })}
          className="mt-6 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
        >
          Manage API keys
        </button>
      </div>
    )
  }

  const plans = config?.premium_plans ?? []

  return (
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-8">
        <MdRocketLaunch className="text-5xl text-amber-500 mx-auto mb-2" />
        <h1 className="text-2xl font-semibold text-gray-900 m-0">Premium</h1>
        <p className="text-sm text-gray-500 mt-1">
          A recurring subscription unlocks the SFS API for as long as it&rsquo;s active.
        </p>
      </div>

      <div className="border border-gray-200 rounded-2xl p-6 bg-white shadow-sm">
        <ul className="list-none p-0 m-0 mb-6 mt-4 flex flex-col gap-2">
          {FEATURES.map((f) => (
            <li key={f} className="flex items-start gap-2 text-sm text-gray-700">
              <MdCheck className="text-green-500 shrink-0 mt-0.5" /> {f}
            </li>
          ))}
        </ul>

        {search.status === 'cancelled' && (
          <p className="text-sm text-amber-600 mb-4">Checkout was cancelled. You can try again below.</p>
        )}
        {error && <p className="text-sm text-red-500 mb-4">{error}</p>}
        {confirm.isPending && <p className="text-sm text-gray-500 mb-4">Confirming subscription…</p>}

        {configLoading ? (
          <p className="text-sm text-gray-400 m-0">Loading payment options…</p>
        ) : !config?.paypal_client_id ? (
          <p className="text-sm text-red-500 m-0">Payments are not configured.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <PremiumPlanSelector plans={plans} selected={plan} onSelect={setPlan} disabled={confirm.isPending} />
            <PayPalSubscribeButton
              clientId={config.paypal_client_id}
              createSubscription={handleCreateSubscription}
              onApprove={handleApprove}
              onError={(msg) => setError(msg)}
              onCancel={() => setError(null)}
              disabled={confirm.isPending}
            />
          </div>
        )}
      </div>
    </div>
  )
}
