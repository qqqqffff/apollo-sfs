import type {
  AccountMergeDetails, AuditDetails, OperationAuditDetails, PremiumAuditDetails,
  RequestFailureDetails, StorageAllocationChangeDetails,
} from '../types/api'

// Narrowing helpers: audit_logs.details is a different shape per action.

export function isAllocationDetails(d?: AuditDetails): d is StorageAllocationChangeDetails {
  return !!d && Array.isArray((d as StorageAllocationChangeDetails).before)
}

export function isFailureDetails(d?: AuditDetails): d is RequestFailureDetails {
  return !!d && typeof (d as RequestFailureDetails).status === 'number'
}

export function isOperationDetails(d?: AuditDetails): d is OperationAuditDetails {
  return !!d && typeof (d as OperationAuditDetails).duration_ms === 'number' && !isFailureDetails(d)
}

export function isPremiumDetails(d?: AuditDetails): d is PremiumAuditDetails {
  return !!d && typeof (d as PremiumAuditDetails).source === 'string'
}

export function isMergeDetails(d?: AuditDetails): d is AccountMergeDetails {
  return !!d && Array.isArray((d as AccountMergeDetails).merged_accounts)
}

// formatDuration renders milliseconds the way an admin wants to read them:
// sub-second operations in ms (with a decimal under 10 ms), longer ones in
// seconds or minutes.
export function formatDuration(ms: number): string {
  if (ms < 10) return `${ms.toFixed(1)} ms`
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s - m * 60)}s`
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number): string {
  let v = bytes
  let i = 0
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${UNITS[i]}`
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

// operationSummary is the one-line timing note under a file/folder entry, e.g.
// "1.2 GB in 41.3 s · avg 29.8 MB/s (38.0 s transferring, 120 chunks)" or
// "took 4.2 ms".
export function operationSummary(d: OperationAuditDetails): string {
  if (d.size_bytes != null && d.avg_speed_bps) {
    const extra: string[] = []
    if (d.transfer_ms != null && d.transfer_ms < d.duration_ms * 0.95) {
      extra.push(`${formatDuration(d.transfer_ms)} transferring`)
    }
    if (d.chunks && d.chunks > 1) extra.push(`${d.chunks} chunks`)
    return `${formatBytes(d.size_bytes)} in ${formatDuration(d.duration_ms)} · avg ${formatSpeed(d.avg_speed_bps)}` +
      (extra.length ? ` (${extra.join(', ')})` : '')
  }
  return `took ${formatDuration(d.duration_ms)}`
}

export function failureSummary(d: RequestFailureDetails): string {
  const parts = [`${d.status}`, `${d.method} ${d.route.replace(/^\/api\/v1/, '')}`]
  let s = parts.join(' · ')
  if (d.error) s += ` — ${d.error}`
  if (d.repeats) s += ` (+${d.repeats} more in the following minute)`
  return s
}

const PREMIUM_SOURCE: Record<PremiumAuditDetails['source'], string> = {
  subscription: 'PayPal subscription',
  self_billed: 'card/wallet subscription',
  admin_trial: 'premium trial',
}

export function premiumSummary(d: PremiumAuditDetails): string {
  const bits = [PREMIUM_SOURCE[d.source] ?? d.source]
  if (d.plan) bits.push(`${d.plan} plan`)
  if (d.period_end) bits.push(`ended ${new Date(d.period_end).toLocaleString()}`)
  let s = bits.join(' · ')
  if (d.reason) s += ` — ${d.reason}`
  return s
}
