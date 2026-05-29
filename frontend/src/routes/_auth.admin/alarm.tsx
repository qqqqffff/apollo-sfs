import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { alarmSettingsQueryOptions, toggleAlarmSubscription } from '../../api/admin'
import type { AlarmSettings, AlarmType } from '../../api/admin'
import { meQueryOptions } from '../../api/me'
import { ApiError } from '../../api/client'
import { useNotification } from '../../context/NotificationContext'

export const Route = createFileRoute('/_auth/admin/alarm')({
  component: RouteComponent,
})

interface AlarmItem {
  key: AlarmType
  label: string
  description: string
  emailsKey: keyof AlarmSettings
  lastFiredKey: keyof AlarmSettings
}

const ALARM_ITEMS: AlarmItem[] = [
  {
    key: 'cpu_usage',
    label: 'CPU Usage',
    description: 'Alert when average CPU usage is ≥ 90% for 30 minutes.',
    emailsKey: 'cpu_usage_emails',
    lastFiredKey: 'cpu_usage_last_fired_at',
  },
  {
    key: 'cpu_temp',
    label: 'CPU Temperature',
    description: 'Alert when average CPU temperature is ≥ 75°C for 30 minutes.',
    emailsKey: 'cpu_temp_emails',
    lastFiredKey: 'cpu_temp_last_fired_at',
  },
  {
    key: 'drive_temp',
    label: 'Drive Temperature',
    description: 'Alert when average drive temperature is ≥ 50°C for 30 minutes.',
    emailsKey: 'drive_temp_emails',
    lastFiredKey: 'drive_temp_last_fired_at',
  },
  {
    key: 'drive_load',
    label: 'Drive Load',
    description: 'Alert when any drive has ≥ 90% of its quota capacity allocated.',
    emailsKey: 'drive_load_emails',
    lastFiredKey: 'drive_load_last_fired_at',
  },
  {
    key: 'network_traffic',
    label: 'Network Traffic',
    description: 'Alert when average throughput is ≥ 90% of the last speed test for 30 minutes.',
    emailsKey: 'network_traffic_emails',
    lastFiredKey: 'network_traffic_last_fired_at',
  },
  {
    key: 'api_error_rate',
    label: 'API Error Rate',
    description: 'Alert when ≥ 5% of API requests return a server error over the past 30 minutes.',
    emailsKey: 'api_error_rate_emails',
    lastFiredKey: 'api_error_rate_last_fired_at',
  },
]

function formatLastFired(ts: string | null | undefined): string {
  if (!ts) return 'Never'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ts))
}

function RouteComponent() {
  const queryClient = useQueryClient()
  const { notify } = useNotification()

  const { data: settings, isLoading, error } = useQuery(alarmSettingsQueryOptions)
  const { data: me } = useQuery(meQueryOptions)

  const [openInfo, setOpenInfo] = useState<AlarmType | null>(null)

  const subscribeMutation = useMutation({
    mutationFn: ({ alarmType, subscribed }: { alarmType: AlarmType; subscribed: boolean }) =>
      toggleAlarmSubscription(alarmType, subscribed),
    onSuccess: (updated) => {
      queryClient.setQueryData(alarmSettingsQueryOptions.queryKey, updated)
    },
    onError: (err) => {
      notify('error', err instanceof ApiError ? err.message : 'Failed to update subscription')
    },
  })

  if (isLoading) {
    return <p className="text-sm text-gray-500">Loading alarm settings…</p>
  }

  if (error) {
    return <p className="text-sm text-red-600">Failed to load alarm settings.</p>
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Alarm Settings</h1>
        <p className="mt-1 text-sm text-gray-500">
          Toggle each alarm to subscribe or unsubscribe your account from email notifications.
          Notifications have a 1-hour cooldown per alarm type to prevent spam.
        </p>
      </div>

      <section className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        <h2 className="text-sm font-semibold text-gray-900 px-5 pt-5 pb-3">Alarm Events</h2>
        {ALARM_ITEMS.map(({ key, label, description, emailsKey, lastFiredKey }) => {
          const emails = (settings?.[emailsKey] as string[]) ?? []
          const lastFired = settings?.[lastFiredKey] as string | null
          const subscribed = me?.email ? emails.includes(me.email) : false
          const pending = subscribeMutation.isPending && subscribeMutation.variables?.alarmType === key
          const infoOpen = openInfo === key

          return (
            <div key={key} className="px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900">{label}</p>
                  <p className="text-sm text-gray-500 mt-0.5">{description}</p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {/* Info button */}
                  <button
                    onClick={() => setOpenInfo(infoOpen ? null : key)}
                    aria-label={`Show info for ${label}`}
                    aria-expanded={infoOpen}
                    className={`w-7 h-7 flex items-center justify-center rounded-full text-xs font-semibold border transition-colors cursor-pointer ${
                      infoOpen
                        ? 'bg-blue-100 border-blue-300 text-blue-700'
                        : 'bg-gray-100 border-gray-200 text-gray-500 hover:bg-gray-200'
                    }`}
                  >
                    i
                  </button>

                  {/* Subscribe toggle */}
                  <button
                    role="switch"
                    aria-checked={subscribed}
                    aria-label={`Subscribe to ${label} alarm`}
                    disabled={pending}
                    onClick={() =>
                      subscribeMutation.mutate({ alarmType: key, subscribed: !subscribed })
                    }
                    className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 ${
                      pending ? 'cursor-wait' : 'cursor-pointer'
                    } ${subscribed ? 'bg-blue-600' : 'bg-gray-200'}`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
                        subscribed ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* Info panel */}
              {infoOpen && (
                <div className="mt-3 rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm space-y-2">
                  <div className="flex items-start gap-2">
                    <span className="text-gray-500 shrink-0">Last sent:</span>
                    <span className="text-gray-800">{formatLastFired(lastFired)}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-gray-500 shrink-0">Subscribers:</span>
                    {emails.length === 0 ? (
                      <span className="text-gray-400 italic">No subscribers</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {emails.map((email) => (
                          <li key={email} className="text-gray-800">
                            {email}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </section>
    </div>
  )
}
