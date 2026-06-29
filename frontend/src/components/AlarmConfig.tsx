import { useEffect, useState } from 'react'
import { ALARM_DEFAULT_THRESHOLD, ALARM_UNIT } from '../api/admin'
import type { AlarmSubscription, AlarmType } from '../api/admin'

interface AlarmConfigProps {
  alarmType: AlarmType
  label: string
  description?: string
  /** The caller's subscription for this exact target, if any. */
  subscription?: AlarmSubscription
  /** Target label shown beneath the alarm name (e.g. node hostname / drive). */
  targetLabel?: string
  pending?: boolean
  /** Subscribe or update the threshold for this alarm/target. */
  onUpsert: (threshold: number) => void
  /** Unsubscribe the caller from this alarm/target. */
  onRemove: () => void
}

function formatLastFired(ts: string | null | undefined): string {
  if (!ts) return 'Never'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts))
}

// AlarmConfig renders one alarm as a row with a subscribe toggle and an editable
// threshold. Shared between the metrics page (contextual to the selected
// node/drive) and the admin review page (per-user). Subscription state and the
// network calls are owned by the parent via onUpsert / onRemove.
export function AlarmConfig({
  alarmType,
  label,
  description,
  subscription,
  targetLabel,
  pending,
  onUpsert,
  onRemove,
}: AlarmConfigProps) {
  const subscribed = !!subscription
  const unit = ALARM_UNIT[alarmType]
  const [threshold, setThreshold] = useState<string>(
    String(subscription?.threshold ?? ALARM_DEFAULT_THRESHOLD[alarmType]),
  )

  // Keep the input in sync when the subscription threshold changes underneath us
  // (e.g. another tab, or after selecting a different target/user).
  useEffect(() => {
    setThreshold(String(subscription?.threshold ?? ALARM_DEFAULT_THRESHOLD[alarmType]))
  }, [subscription?.id, subscription?.threshold, alarmType])

  function commitThreshold() {
    if (!subscribed) return
    const v = Number(threshold)
    if (!Number.isFinite(v) || v <= 0 || v === subscription?.threshold) return
    onUpsert(v)
  }

  function toggle() {
    if (subscribed) {
      onRemove()
    } else {
      const v = Number(threshold)
      onUpsert(Number.isFinite(v) && v > 0 ? v : ALARM_DEFAULT_THRESHOLD[alarmType])
    }
  }

  return (
    <div className="px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900">{label}</p>
          {targetLabel && <p className="text-xs text-gray-400 mt-0.5">{targetLabel}</p>}
          {description && <p className="text-sm text-gray-500 mt-0.5">{description}</p>}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {/* Threshold input */}
          <div className={`flex items-center gap-1 ${subscribed ? '' : 'opacity-40'}`}>
            <input
              type="number"
              inputMode="decimal"
              value={threshold}
              disabled={!subscribed || pending}
              onChange={(e) => setThreshold(e.target.value)}
              onBlur={commitThreshold}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              aria-label={`${label} threshold`}
              className="w-16 text-right text-sm border border-gray-200 rounded-md px-2 py-1 tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
            />
            <span className="text-xs text-gray-400 whitespace-nowrap">{unit}</span>
          </div>

          {/* Subscribe toggle */}
          <button
            role="switch"
            aria-checked={subscribed}
            aria-label={`Toggle ${label} alarm`}
            disabled={pending}
            onClick={toggle}
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

      {subscribed && (
        <div className="mt-2 text-xs text-gray-400">
          Last sent: <span className="text-gray-600">{formatLastFired(subscription?.last_fired_at)}</span>
        </div>
      )}
    </div>
  )
}
