import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { alarmSettingsQueryOptions, updateAlarmSettings } from '../../api/admin'
import type { AlarmSettings } from '../../api/admin'
import { ApiError } from '../../api/client'
import { useNotification } from '../../context/NotificationContext'

export const Route = createFileRoute('/_auth/admin/alarm')({
  component: RouteComponent,
})

const ALARM_ITEMS: { key: keyof Omit<AlarmSettings, 'notify_emails' | 'updated_at'>; label: string; description: string }[] = [
  {
    key: 'cpu_usage_enabled',
    label: 'CPU Usage',
    description: 'Alert when average CPU usage is ≥ 90% for 30 minutes.',
  },
  {
    key: 'cpu_temp_enabled',
    label: 'CPU Temperature',
    description: 'Alert when average CPU temperature is ≥ 75°C for 30 minutes.',
  },
  {
    key: 'drive_temp_enabled',
    label: 'Drive Temperature',
    description: 'Alert when average drive temperature is ≥ 50°C for 30 minutes.',
  },
  {
    key: 'drive_load_enabled',
    label: 'Drive Load',
    description: 'Alert when any drive has ≥ 90% of its quota capacity allocated.',
  },
  {
    key: 'network_traffic_enabled',
    label: 'Network Traffic',
    description: 'Alert when average throughput is ≥ 90% of the last speed test for 30 minutes.',
  },
  {
    key: 'api_error_rate_enabled',
    label: 'API Error Rate',
    description: 'Alert when ≥ 5% of API requests return a server error over the past 30 minutes.',
  },
]

function RouteComponent() {
  const queryClient = useQueryClient()
  const { notify } = useNotification()

  const { data, isLoading, error } = useQuery(alarmSettingsQueryOptions)

  const [emails, setEmails] = useState<string[]>([])
  const [emailInput, setEmailInput] = useState('')
  const [flags, setFlags] = useState<Omit<AlarmSettings, 'notify_emails' | 'updated_at'>>({
    cpu_usage_enabled: false,
    cpu_temp_enabled: false,
    drive_temp_enabled: false,
    drive_load_enabled: false,
    network_traffic_enabled: false,
    api_error_rate_enabled: false,
  })
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!data) return
    setEmails(data.notify_emails ?? [])
    setFlags({
      cpu_usage_enabled: data.cpu_usage_enabled,
      cpu_temp_enabled: data.cpu_temp_enabled,
      drive_temp_enabled: data.drive_temp_enabled,
      drive_load_enabled: data.drive_load_enabled,
      network_traffic_enabled: data.network_traffic_enabled,
      api_error_rate_enabled: data.api_error_rate_enabled,
    })
    setDirty(false)
  }, [data])

  const saveMutation = useMutation({
    mutationFn: () => updateAlarmSettings({ notify_emails: emails, ...flags }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'alarm', 'settings'] })
      setDirty(false)
      notify('success', 'Alarm settings saved')
    },
    onError: (err) => {
      notify('error', err instanceof ApiError ? err.message : 'Failed to save alarm settings')
    },
  })

  function toggleFlag(key: keyof typeof flags) {
    setFlags((prev) => ({ ...prev, [key]: !prev[key] }))
    setDirty(true)
  }

  function addEmail() {
    const trimmed = emailInput.trim().toLowerCase()
    if (!trimmed || emails.includes(trimmed)) {
      setEmailInput('')
      return
    }
    setEmails((prev) => [...prev, trimmed])
    setEmailInput('')
    setDirty(true)
  }

  function removeEmail(email: string) {
    setEmails((prev) => prev.filter((e) => e !== email))
    setDirty(true)
  }

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
          Configure email notifications for sustained server health events. Notifications have a
          1-hour cooldown per alarm type to prevent spam.
        </p>
      </div>

      {/* Notification recipients */}
      <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-semibold text-gray-900">Notification Recipients</h2>
        <p className="text-sm text-gray-500">
          These email addresses receive alarm notifications. At least one address is required for
          any alarm to send.
        </p>

        <div className="flex gap-2">
          <input
            type="email"
            placeholder="admin@example.com"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addEmail()}
            className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={addEmail}
            className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors cursor-pointer"
          >
            Add
          </button>
        </div>

        {emails.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No recipients configured.</p>
        ) : (
          <ul className="space-y-2">
            {emails.map((email) => (
              <li key={email} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-gray-800">{email}</span>
                <button
                  onClick={() => removeEmail(email)}
                  className="text-gray-400 hover:text-red-600 transition-colors cursor-pointer"
                  aria-label={`Remove ${email}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Alarm toggles */}
      <section className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        <h2 className="text-sm font-semibold text-gray-900 px-5 pt-5 pb-3">Alarm Events</h2>
        {ALARM_ITEMS.map(({ key, label, description }) => (
          <div key={key} className="flex items-start justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900">{label}</p>
              <p className="text-sm text-gray-500 mt-0.5">{description}</p>
            </div>
            <button
              role="switch"
              aria-checked={flags[key]}
              onClick={() => toggleFlag(key)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                flags[key] ? 'bg-blue-600' : 'bg-gray-200'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
                  flags[key] ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        ))}
      </section>

      {/* Save button */}
      <div className="flex justify-end">
        <button
          onClick={() => saveMutation.mutate()}
          disabled={!dirty || saveMutation.isPending}
          className="text-sm px-5 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          {saveMutation.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}
