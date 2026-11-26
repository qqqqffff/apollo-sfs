import {
  failureSummary, formatBytes, formatDuration, isAllocationDetails, isFailureDetails,
  isOperationDetails, isPremiumDetails, operationSummary, premiumSummary,
} from '../../utils/auditFormat'

describe('formatDuration', () => {
  test.each([
    [0.4, '0.4 ms'],
    [12.6, '13 ms'],
    [999, '999 ms'],
    [1500, '1.50 s'],
    [41_300, '41.3 s'],
    [125_000, '2m 5s'],
  ])('%p ms → %p', (ms, want) => expect(formatDuration(ms)).toBe(want))
})

test('formatBytes', () => {
  expect(formatBytes(512)).toBe('512 B')
  expect(formatBytes(1536)).toBe('1.5 KB')
  expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB')
})

test('detail type guards tell the payloads apart', () => {
  const alloc = { before: [], after: [] }
  const op = { duration_ms: 3 }
  const fail = { status: 500, method: 'POST', route: '/x', duration_ms: 3 }
  const prem = { source: 'admin_trial' as const }
  expect(isAllocationDetails(alloc)).toBe(true)
  expect(isOperationDetails(op)).toBe(true)
  expect(isOperationDetails(fail)).toBe(false)
  expect(isFailureDetails(fail)).toBe(true)
  expect(isPremiumDetails(prem)).toBe(true)
  expect(isAllocationDetails(undefined)).toBe(false)
})

test('operationSummary shows size, time and speed for uploads', () => {
  expect(operationSummary({
    duration_ms: 41_300, transfer_ms: 38_000, size_bytes: 1.2 * 1024 ** 3, avg_speed_bps: 33_900_000, chunks: 120,
  })).toBe('1.2 GB in 41.3 s · avg 32.3 MB/s (38.0 s transferring, 120 chunks)')
  expect(operationSummary({ duration_ms: 4.2 })).toBe('took 4.2 ms')
})

test('failureSummary and premiumSummary', () => {
  expect(failureSummary({
    status: 413, method: 'POST', route: '/api/v1/files/upload', error: 'storage quota exceeded', duration_ms: 3, repeats: 2,
  })).toBe('413 · POST /files/upload — storage quota exceeded (+2 more in the following minute)')
  expect(premiumSummary({ source: 'subscription', plan: 'monthly', reason: 'BILLING.SUBSCRIPTION.EXPIRED' }))
    .toBe('PayPal subscription · monthly plan — BILLING.SUBSCRIPTION.EXPIRED')
})
