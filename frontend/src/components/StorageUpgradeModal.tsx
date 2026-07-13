import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  MdBolt,
  MdCheckCircle,
  MdClose,
  MdExpandLess,
  MdExpandMore,
  MdStorage,
  MdDns,
  MdWarningAmber,
} from 'react-icons/md'
import { meQueryOptions } from '../api/me'
import { listServers, pingServer, type PublicServer } from '../api/storage'
import { useBillingConfig } from '../hooks/useBillingConfig'
import {
  STORAGE_PLANS,
  CUSTOM_PLAN_ID,
  CUSTOM_PER_TIB_CENTS,
  TIB,
  buildCustomTibStops,
  captureExpansionOrder,
  captureStorageOrder,
  createExpansionOrder,
  createStorageOrder,
  customPriceCents,
  formatCents,
  listMyExpansionRequests,
  submitCustomRequest,
  type StorageType,
} from '../api/billing'
import { ApiError } from '../api/client'
import { PayPalCheckoutOptions, CheckoutBackButton } from './PayPalCheckoutOptions'
import { HostedCardFields } from './HostedCardFields'

// Requests still working their way through review/provisioning — anything not
// in this closed set counts as "in progress" for blocking a duplicate custom
// request. Mirrors the closed-request check implied by orders.tsx's grouping.
const CLOSED_EXPANSION_STATUSES = new Set(['completed', 'expired', 'refunded', 'rejected'])

// Allocation threshold above which direct purchases on a server are blocked
// and the user is steered to an expansion request. Mirrors the backend rule.
const MAX_ALLOCATED_PCT = 90

// Auto-prompt threshold: an upload pushing usage past this percentage of quota
// (or over it) opens this modal, unless disabled in preferences.
export const STORAGE_PROMPT_THRESHOLD = 0.75

// Custom capacity slider ladder, in TiB: 1 TB steps to 32 TB, 4 TB steps to
// 160 TB, 16 TB steps to 512 TB, 64 TB steps to 2 PB, 256 TB steps to 10 PB.
const CUSTOM_TIB_STOPS = buildCustomTibStops()

function formatSize(bytes: number): string {
  if (bytes >= 1024 * TIB) return `${(bytes / (1024 * TIB)).toFixed(bytes % (1024 * TIB) === 0 ? 0 : 1)} PB`
  if (bytes >= TIB) return `${(bytes / TIB).toFixed(bytes % TIB === 0 ? 0 : 1)} TB`
  const GB = 1024 ** 3
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes % GB === 0 ? 0 : 1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

interface ServerRow extends PublicServer {
  allocated_pct: number
  // One logical server can expose both tiers, yielding two rows with the SAME
  // server id (one per drive_type). Selecting by bare id always resolves to
  // whichever row sorts first (hdd), making every fast plan look unavailable
  // even when the fast tier has room — so rows are keyed by id + tier instead.
  row_key: string
}

interface Props {
  onClose: () => void
  onPurchased?: (newQuotaBytes: number) => void
  // Set when the modal was auto-opened because an upload would exceed the
  // quota (or push it past 75%); shows an explanatory banner.
  promptReason?: 'upload-near-quota' | 'upload-over-quota' | null
}

type Phase = 'select' | 'purchased' | 'expansion_requested' | 'custom_submitted'

export function StorageUpgradeModal({ onClose, onPurchased, promptReason }: Props) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: user } = useQuery(meQueryOptions)

  const { data: config, isLoading: configLoading } = useBillingConfig()

  const { data: servers, isLoading: serversLoading, error: serversError } = useQuery({
    queryKey: ['storage', 'servers'],
    queryFn: async (): Promise<ServerRow[]> => {
      const list = await listServers()
      return list.map((s) => ({
        ...s,
        allocated_pct: s.total_capacity_bytes > 0
          ? ((s.total_capacity_bytes - s.available_bytes) / s.total_capacity_bytes) * 100
          : 0,
        row_key: `${s.id}:${s.drive_type}`,
      }))
    },
    staleTime: 60 * 1000,
  })

  // Single latency reading against the manager (the node that actually serves
  // the API/frontend) rather than one ping per server row — every row's ping
  // URL round-trips through the same manager-hosted API regardless of which
  // storage tier it names, so per-row pings only ever showed the same number
  // twice with sampling jitter, not a real fast-vs-standard difference.
  const { data: managerPingMs } = useQuery({
    queryKey: ['storage', 'manager-ping'],
    queryFn: () => pingServer('/api/v1/health'),
    staleTime: 30 * 1000,
    retry: false,
  })

  const { data: myExpansionRequests } = useQuery({
    queryKey: ['billing', 'expansion-requests'],
    queryFn: listMyExpansionRequests,
  })

  const [storageType, setStorageType] = useState<StorageType>('nvme')
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [customStopIdx, setCustomStopIdx] = useState(0)
  const [selectedServerKey, setSelectedServerKey] = useState<string | null>(null)
  const [serverListOpen, setServerListOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>('select')
  const [showCardForm, setShowCardForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)
  const [expansionResult, setExpansionResult] = useState<{ id: string; expiresAt: string } | null>(null)
  const [customResult, setCustomResult] = useState<{ reviewDueAt: string; estimateCents: number } | null>(null)
  const [newQuota, setNewQuota] = useState<number | null>(null)

  // Default server selection once servers load, and re-select a server row
  // matching the active storage type tab whenever it changes. Without this,
  // the previously selected row (e.g. the standard-tier one, if it sorts
  // first alphabetically) stays selected after switching to "Fast", making
  // every plan look unavailable even when the fast tier has room.
  useEffect(() => {
    if (!servers || servers.length === 0) return
    setSelectedServerKey((prev) => {
      const prevServer = prev ? servers.find((s) => s.row_key === prev) : undefined
      if (prevServer && prevServer.drive_type === storageType) return prev
      const match = servers.find((s) => s.drive_type === storageType)
      return (match ?? servers[0]).row_key
    })
  }, [servers, storageType])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, busy])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const selectedServer = servers?.find((s) => s.row_key === selectedServerKey)
  const isCustom = selectedPlanId === CUSTOM_PLAN_ID
  const customBytes = CUSTOM_TIB_STOPS[customStopIdx] * TIB
  const selectedPlan = STORAGE_PLANS.find((p) => p.id === selectedPlanId)

  const planBytes = isCustom ? customBytes : (selectedPlan?.addBytes ?? 0)
  const fullPriceCents = isCustom
    ? customPriceCents(customBytes, storageType)
    : (selectedPlan?.priceCents[storageType] ?? 0)
  const depositCents = Math.ceil(fullPriceCents / 2)

  const serverAtCapacity = !!selectedServer && selectedServer.allocated_pct >= MAX_ALLOCATED_PCT
  const serverTypeMismatch = !!selectedServer && selectedServer.drive_type !== storageType
  const serverLacksCapacity = !!selectedServer && planBytes > selectedServer.available_bytes

  // Admin-only, session-scoped override (see SandboxPaymentsToggle on the
  // profile page) that forces every plan purchase through the expansion
  // request flow below, regardless of actual server capacity — lets an
  // admin test that flow without needing a server actually near capacity.
  const expansionOverride = !!user?.expansion_override_enabled

  // Deposit-based expansion request instead of a direct purchase when the
  // override above is on, or the server can't take the purchase (>=90%
  // allocated, wrong tier, or not enough free capacity). Custom amounts
  // never pay here: they are submitted without payment (estimated price)
  // and invoiced after manual review.
  const isExpansion = !!selectedPlanId && !isCustom && !!selectedServer &&
    (expansionOverride || serverAtCapacity || serverTypeMismatch || serverLacksCapacity)

  // An already-open custom request for this exact server + storage type —
  // submitting another would just duplicate manual review work, so the
  // custom option is replaced with a link to the existing request instead.
  const existingCustomRequest = useMemo(
    () => (myExpansionRequests ?? []).find((r) =>
      r.is_custom &&
      r.server_id === selectedServer?.id &&
      r.storage_type === storageType &&
      !CLOSED_EXPANSION_STATUSES.has(r.status),
    ),
    [myExpansionRequests, selectedServer, storageType],
  )

  // Clear an active custom selection if it becomes blocked underneath the
  // user (e.g. they had it selected, then switched server/tier onto a
  // combination that already has an in-progress custom request).
  useEffect(() => {
    if (isCustom && existingCustomRequest) setSelectedPlanId(null)
  }, [isCustom, existingCustomRequest])

  // The server list holds one row per (server, drive_type) — a server exposing
  // both tiers yields two rows with the same id (see ServerRow.row_key).
  // Group them back into one entry per physical server for the picker so
  // e.g. "NH-0001" appears once, with a badge per tier it actually has,
  // instead of as two separate list entries.
  const groupedServers = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; rows: ServerRow[] }>()
    for (const s of servers ?? []) {
      const group = byId.get(s.id)
      if (group) group.rows.push(s)
      else byId.set(s.id, { id: s.id, name: s.name, rows: [s] })
    }
    return [...byId.values()]
  }, [servers])

  const fastAvailable = useMemo(
    () => (servers ?? []).filter((s) => s.drive_type === 'nvme').reduce((sum, s) => sum + s.available_bytes, 0),
    [servers],
  )
  const hddAvailable = useMemo(
    () => (servers ?? []).filter((s) => s.drive_type === 'hdd').reduce((sum, s) => sum + s.available_bytes, 0),
    [servers],
  )

  const canPay = !!selectedPlanId && !!selectedServer && phase === 'select' && !busy

  const amountCents = isExpansion ? depositCents : fullPriceCents

  async function handleCreateOrder(): Promise<string> {
    setPayError(null)
    if (!selectedPlanId || !selectedServer) throw new Error('No plan selected')
    try {
      if (isExpansion) {
        const res = await createExpansionOrder(selectedPlanId, storageType, selectedServer.id)
        return res.order_id
      }
      const res = await createStorageOrder(selectedPlanId, storageType, selectedServer.id)
      return res.order_id
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not start checkout'
      setPayError(msg)
      throw err
    }
  }

  // Same order-creation call as handleCreateOrder, for the "PayPal" wallet
  // button — which redirects the browser to the approval URL rather than
  // using the popup-based createOrder/onApprove pair (see
  // PayPalWalletRedirectButton). A fresh order per click, same as every other
  // payment method here.
  async function handleGetApprovalUrl(): Promise<string> {
    setPayError(null)
    if (!selectedPlanId || !selectedServer) throw new Error('No plan selected')
    try {
      if (isExpansion) {
        const res = await createExpansionOrder(selectedPlanId, storageType, selectedServer.id)
        return res.approval_url
      }
      const res = await createStorageOrder(selectedPlanId, storageType, selectedServer.id)
      return res.approval_url
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not start checkout'
      setPayError(msg)
      throw err
    }
  }

  async function handleSubmitCustom() {
    if (!selectedServer || !isCustom) return
    setBusy(true)
    setPayError(null)
    try {
      const res = await submitCustomRequest(storageType, selectedServer.id, customBytes)
      setCustomResult({ reviewDueAt: res.review_due_at, estimateCents: res.estimated_price_cents })
      setPhase('custom_submitted')
      queryClient.invalidateQueries({ queryKey: ['billing', 'expansion-requests'] })
    } catch (err) {
      setPayError(err instanceof ApiError ? err.message : 'Could not submit request')
    } finally {
      setBusy(false)
    }
  }

  async function handleApprove(data: { orderID: string }) {
    setBusy(true)
    setPayError(null)
    try {
      if (isExpansion) {
        const res = await captureExpansionOrder(data.orderID)
        setExpansionResult({ id: res.expansion_request_id, expiresAt: res.expires_at })
        setPhase('expansion_requested')
        queryClient.invalidateQueries({ queryKey: ['billing', 'expansion-requests'] })
      } else {
        const res = await captureStorageOrder(data.orderID)
        setNewQuota(res.new_quota_bytes)
        setPhase('purchased')
        await queryClient.invalidateQueries({ queryKey: ['me'] })
        queryClient.invalidateQueries({ queryKey: ['storage'] })
        onPurchased?.(res.new_quota_bytes)
      }
    } catch (err) {
      setPayError(err instanceof ApiError ? err.message : 'Payment capture failed')
    } finally {
      setBusy(false)
    }
  }

  const usedPct = user && user.storage_quota_bytes > 0
    ? Math.min((user.storage_used_bytes / user.storage_quota_bytes) * 100, 100)
    : 0

  return (
    <div
      onClick={() => { if (!busy) onClose() }}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-130 max-w-[94vw] max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-gray-900 m-0">Add storage</h3>
            {config?.environment === 'sandbox' && (
              <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-purple-100 text-purple-700 rounded">
                Sandbox payment
              </span>
            )}
            {expansionOverride && (
              <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-amber-100 text-amber-700 rounded">
                Server expansion only
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-gray-400 hover:text-gray-600 cursor-pointer transition-colors disabled:opacity-40 bg-transparent border-0 p-0"
          >
            <MdClose className="text-xl" />
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-5 flex flex-col gap-5">
          {/* Success panels */}
          {phase === 'purchased' && (
            <div className="flex flex-col items-center text-center py-6 gap-3">
              <MdCheckCircle className="text-5xl text-green-500" />
              <h4 className="text-lg font-semibold text-gray-900 m-0">Storage added</h4>
              <p className="text-sm text-gray-500 m-0">
                Your new quota is <span className="font-semibold text-gray-800">{newQuota != null ? formatSize(newQuota) : '—'}</span>.
              </p>
              <button
                onClick={onClose}
                className="mt-2 px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
              >
                Done
              </button>
            </div>
          )}

          {phase === 'expansion_requested' && (
            <div className="flex flex-col items-center text-center py-6 gap-3">
              <MdCheckCircle className="text-5xl text-green-500" />
              <h4 className="text-lg font-semibold text-gray-900 m-0">Expansion request submitted</h4>
              <p className="text-sm text-gray-600 m-0 max-w-sm">
                Your 50% deposit was received.{' '}
                {isCustom
                  ? 'Custom requests are manually reviewed within 3 business days.'
                  : 'Your request will be reviewed within 7 business days.'}{' '}
                Once approved, the capacity will be expanded within 14 business days.
                If either deadline is missed, your deposit is refunded automatically.
              </p>
              {expansionResult && (
                <p className="text-xs text-gray-400 m-0">
                  Review due by {new Date(expansionResult.expiresAt).toLocaleDateString()}
                </p>
              )}
              <p className="text-xs text-gray-400 m-0 max-w-sm">
                You can track this request on your profile page. The remaining balance is
                charged only after your capacity is provisioned.
              </p>
              <button
                onClick={onClose}
                className="mt-2 px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
              >
                Done
              </button>
            </div>
          )}

          {phase === 'custom_submitted' && (
            <div className="flex flex-col items-center text-center py-6 gap-3">
              <MdCheckCircle className="text-5xl text-green-500" />
              <h4 className="text-lg font-semibold text-gray-900 m-0">Custom request submitted</h4>
              <p className="text-sm text-gray-600 m-0 max-w-sm">
                Your request for {formatSize(customBytes)} of {storageType === 'nvme' ? 'fast' : 'standard'} storage
                will be manually reviewed within <span className="font-semibold">3 business days</span>.
                {customResult && (
                  <> The estimated price is <span className="font-semibold">{formatCents(customResult.estimateCents)}</span> —
                  an invoice with the final amount will be emailed to you after review.</>
                )}
              </p>
              {customResult && (
                <p className="text-xs text-gray-400 m-0">
                  Review due by {new Date(customResult.reviewDueAt).toLocaleDateString()}
                </p>
              )}
              <p className="text-xs text-gray-400 m-0 max-w-sm">
                No payment has been taken. You'll have 14 business days to review and accept the
                invoice (paying any listed deposit) before the request expires.
              </p>
              <button
                onClick={onClose}
                className="mt-2 px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
              >
                Done
              </button>
            </div>
          )}

          {phase === 'select' && showCardForm && (
            <>
              <CheckoutBackButton onClick={() => { setShowCardForm(false); setPayError(null) }} disabled={busy} />

              {selectedServer && selectedPlanId && (
                <div className="border border-gray-200 rounded-xl px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-800">
                        {isCustom ? `Custom — ${formatSize(customBytes)}` : selectedPlan?.label}
                      </span>
                      <TierBadge type={storageType} />
                    </div>
                    <span className="text-sm font-semibold text-gray-800">
                      {isExpansion ? `${formatCents(amountCents)} deposit` : formatCents(amountCents)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 m-0 mt-1">{selectedServer.name}</p>
                </div>
              )}

              {payError && <p className="text-xs text-red-500 m-0">{payError}</p>}
              {busy && <p className="text-xs text-gray-500 m-0">Verifying payment…</p>}

              {config?.paypal_client_id && (
                <HostedCardFields
                  clientId={config.paypal_client_id}
                  currency={config.currency || 'USD'}
                  createOrder={handleCreateOrder}
                  onApprove={(orderId) => handleApprove({ orderID: orderId })}
                  onError={(msg) => { if (!payError) setPayError(msg) }}
                  disabled={!canPay}
                  submitLabel={isExpansion ? `Pay deposit — ${formatCents(amountCents)}` : `Pay ${formatCents(amountCents)}`}
                />
              )}
              <p className="text-[11px] text-gray-400 text-center m-0">
                Payments are processed securely by PayPal. Card details are entered directly into
                PayPal and never touch our servers.
              </p>
            </>
          )}

          {phase === 'select' && !showCardForm && (
            <>
              {promptReason && (
                <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                  <MdWarningAmber className="text-amber-500 text-lg shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-800 m-0">
                    {promptReason === 'upload-over-quota'
                      ? 'This upload exceeds your storage quota. Add capacity to continue.'
                      : 'This upload will bring you past 75% of your storage quota.'}
                  </p>
                </div>
              )}

              {/* Current usage */}
              {user && (
                <div className="border border-gray-200 rounded-xl px-4 py-3">
                  <div className="flex justify-between text-xs text-gray-500 mb-1.5">
                    <span>Current storage</span>
                    <span>
                      {formatSize(user.storage_used_bytes)} of {formatSize(user.storage_quota_bytes)} used ({usedPct.toFixed(0)}%)
                    </span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${usedPct >= 90 ? 'bg-red-500' : usedPct >= 75 ? 'bg-amber-400' : 'bg-blue-500'}`}
                      style={{ width: `${usedPct}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Server picker */}
              <div>
                <div className="flex items-center justify-between">
                  <SectionLabel>Server</SectionLabel>
                  {managerPingMs != null && (
                    <span className="text-[11px] text-gray-400 mb-2">{managerPingMs} ms to server</span>
                  )}
                </div>
                {serversLoading ? (
                  <p className="text-sm text-gray-400 m-0">Finding servers…</p>
                ) : serversError || !servers || servers.length === 0 ? (
                  <p className="text-sm text-red-500 m-0">
                    No servers are currently available. Storage upgrades are disabled until one is available.
                  </p>
                ) : (
                  <div className="border border-gray-200 rounded-xl overflow-hidden">
                    <button
                      onClick={() => setServerListOpen((o) => !o)}
                      className="flex items-center gap-3 w-full px-4 py-3 bg-transparent border-0 cursor-pointer text-left hover:bg-gray-50 transition-colors"
                    >
                      <MdDns className="text-gray-400 text-lg shrink-0" />
                      <div className="flex-1 min-w-0">
                        {selectedServer ? (
                          <>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-800">{selectedServer.name}</span>
                              <TierBadge type={selectedServer.drive_type} />
                              {selectedServer.allocated_pct >= MAX_ALLOCATED_PCT && (
                                <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-red-50 text-red-600 rounded">
                                  {selectedServer.allocated_pct.toFixed(0)}% allocated
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-gray-400 m-0 mt-0.5">
                              {formatSize(selectedServer.available_bytes)} available · {selectedServer.allocated_pct.toFixed(0)}% allocated
                            </p>
                          </>
                        ) : (
                          <span className="text-sm text-gray-500">Select a server</span>
                        )}
                      </div>
                      {serverListOpen ? <MdExpandLess className="text-gray-400" /> : <MdExpandMore className="text-gray-400" />}
                    </button>
                    {serverListOpen && (
                      <div className="border-t border-gray-100 divide-y divide-gray-50">
                        {groupedServers.map((group) => {
                          const preferred = group.rows.find((r) => r.drive_type === storageType) ?? group.rows[0]
                          const isSelected = group.rows.some((r) => r.row_key === selectedServerKey)
                          return (
                            <button
                              key={group.id}
                              onClick={() => {
                                setStorageType(preferred.drive_type)
                                setSelectedServerKey(preferred.row_key)
                                setServerListOpen(false)
                              }}
                              className={`flex items-center gap-3 w-full px-4 py-2.5 border-0 cursor-pointer text-left transition-colors ${
                                isSelected ? 'bg-blue-50' : 'bg-transparent hover:bg-gray-50'
                              }`}
                            >
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className={`text-sm ${isSelected ? 'font-semibold text-blue-700' : 'font-medium text-gray-800'}`}>
                                    {group.name}
                                  </span>
                                  {group.rows.map((s) => (
                                    <span
                                      key={s.row_key}
                                      role="button"
                                      tabIndex={0}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setStorageType(s.drive_type)
                                        setSelectedServerKey(s.row_key)
                                        setServerListOpen(false)
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key !== 'Enter' && e.key !== ' ') return
                                        e.stopPropagation()
                                        setStorageType(s.drive_type)
                                        setSelectedServerKey(s.row_key)
                                        setServerListOpen(false)
                                      }}
                                      className={`rounded ${s.row_key === selectedServerKey ? 'ring-2 ring-blue-400' : ''}`}
                                    >
                                      <TierBadge type={s.drive_type} />
                                    </span>
                                  ))}
                                </div>
                                <p className="text-xs text-gray-400 m-0 mt-0.5">
                                  {group.rows
                                    .map((s) => `${s.drive_type === 'nvme' ? 'Fast' : 'Standard'} ${formatSize(s.available_bytes)} available · ${s.allocated_pct.toFixed(0)}% allocated`)
                                    .join('  ·  ')}
                                </p>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    )}
                    <div className="flex items-center gap-3 px-4 py-2 border-t border-gray-100 bg-gray-50 text-[11px] text-gray-500">
                      <span className="flex items-center gap-1"><MdBolt className="text-blue-500" /> Fast {formatSize(fastAvailable)}</span>
                      <span className="flex items-center gap-1"><MdStorage className="text-amber-500" /> Standard {formatSize(hddAvailable)}</span>
                      <span className="ml-auto">available across all servers</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Storage type */}
              <div>
                <SectionLabel>Storage type</SectionLabel>
                <div className="flex gap-2">
                  {(['nvme', 'hdd'] as StorageType[]).map((t) => (
                    <button
                      key={t}
                      onClick={() => setStorageType(t)}
                      className={`flex-1 flex items-center gap-2 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors ${
                        storageType === t
                          ? 'border-blue-600 bg-blue-600 text-white'
                          : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      {t === 'nvme'
                        ? <MdBolt className={storageType === t ? 'text-white' : 'text-blue-500'} />
                        : <MdStorage className={storageType === t ? 'text-white' : 'text-amber-500'} />}
                      <span className="text-sm font-medium">{t === 'nvme' ? 'Fast' : 'Standard'}</span>
                      <span className={`text-xs ${storageType === t ? 'text-blue-100' : 'text-gray-400'}`}>
                        {t === 'nvme' ? 'NVMe SSD' : 'HDD'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Plans */}
              <div>
                <SectionLabel>Capacity</SectionLabel>
                <div className="flex flex-col gap-2">
                  {STORAGE_PLANS.map((plan) => {
                    const sel = selectedPlanId === plan.id
                    const unavailable = !!selectedServer &&
                      (expansionOverride || serverAtCapacity || selectedServer.drive_type !== storageType || plan.addBytes > selectedServer.available_bytes)
                    return (
                      <button
                        key={plan.id}
                        onClick={() => setSelectedPlanId(plan.id)}
                        className={`flex items-center justify-between px-4 py-3 rounded-xl border cursor-pointer text-left transition-colors ${
                          sel
                            ? 'border-blue-600 bg-blue-50'
                            : unavailable
                              ? 'border-dashed border-gray-300 bg-white hover:bg-gray-50 opacity-80'
                              : 'border-gray-200 bg-white hover:bg-gray-50'
                        }`}
                      >
                        <div>
                          <span className={`text-sm font-semibold ${sel ? 'text-blue-700' : 'text-gray-800'}`}>{plan.label}</span>
                          <p className="text-xs m-0 mt-0.5 text-gray-400">
                            {unavailable
                              ? <span className="text-amber-600">Server expansion required</span>
                              : user ? `New total: ${formatSize(user.storage_quota_bytes + plan.addBytes)}` : ''}
                          </p>
                        </div>
                        <span className={`text-sm font-semibold ${sel ? 'text-blue-700' : 'text-gray-600'}`}>
                          {formatCents(plan.priceCents[storageType])}{unavailable ? '*' : ''}
                        </span>
                      </button>
                    )
                  })}

                  {/* Custom capacity */}
                  {existingCustomRequest ? (
                    <div className="flex flex-col px-4 py-3 rounded-xl border border-dashed border-gray-300 bg-gray-50">
                      <span className="text-sm font-semibold text-gray-800">Custom</span>
                      <p className="text-xs text-gray-500 m-0 mt-0.5">
                        You already have an in-progress custom request for this server and storage type.
                      </p>
                      <button
                        onClick={() => {
                          onClose()
                          navigate({ to: '/client/orders' as never, search: { tab: 'requests' } as never })
                        }}
                        className="self-start text-xs text-blue-600 hover:text-blue-700 bg-transparent border-0 p-0 mt-2 cursor-pointer font-medium transition-colors"
                      >
                        View request in your orders →
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setSelectedPlanId(CUSTOM_PLAN_ID)}
                      className={`flex flex-col px-4 py-3 rounded-xl border cursor-pointer text-left transition-colors ${
                        isCustom ? 'border-blue-600 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-center justify-between w-full">
                        <div>
                          <span className={`text-sm font-semibold ${isCustom ? 'text-blue-700' : 'text-gray-800'}`}>
                            Custom {isCustom ? `— ${formatSize(customBytes)}` : ''}
                          </span>
                          <p className="text-xs text-gray-400 m-0 mt-0.5">
                            Above 1 TB, up to 10 PB · manually reviewed within 3 business days
                          </p>
                        </div>
                        <span className={`text-sm font-semibold text-right ${isCustom ? 'text-blue-700' : 'text-gray-600'}`}>
                          {isCustom
                            ? <>est. {formatCents(customPriceCents(customBytes, storageType))}</>
                            : `est. from ${formatCents(customPriceCents(2 * TIB, storageType))}`}
                        </span>
                      </div>
                      {isCustom && (
                        <div className="mt-3 w-full" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="range"
                            min={0}
                            max={CUSTOM_TIB_STOPS.length - 1}
                            step={1}
                            value={customStopIdx}
                            onChange={(e) => setCustomStopIdx(Number(e.target.value))}
                            className="w-full cursor-pointer accent-blue-600"
                          />
                          <div className="flex justify-between text-[10px] text-gray-400">
                            <span>2 TB</span>
                            <span>10 PB</span>
                          </div>
                          <p className="text-[11px] text-gray-400 m-0 mt-1">
                            Estimated at {formatCents(CUSTOM_PER_TIB_CENTS[storageType])} per TB.
                            The final price is confirmed by invoice after a 3-business-day manual review —
                            no payment is taken now.
                          </p>
                        </div>
                      )}
                    </button>
                  )}
                </div>
              </div>

              {/* Expansion notice (fixed plans, deposit-based) — full explanation of
                  how the request/deposit/provisioning flow works now lives on the
                  orders page instead of duplicated here. */}
              {isExpansion && (
                <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl">
                  <p className="text-xs font-semibold text-amber-800 m-0 mb-1">
                    Capacity expansion request
                  </p>
                  <p className="text-xs text-amber-800 m-0 leading-relaxed">
                    This purchase requires a <span className="font-semibold">50% deposit ({formatCents(depositCents)})</span> and manual review.
                  </p>
                  <Link
                    to="/client/orders"
                    search={{ tab: 'requests' } as never}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-amber-900 font-medium underline hover:no-underline mt-1 inline-block"
                  >
                    How expansion requests work →
                  </Link>
                </div>
              )}

              {/* Custom request notice (no payment now, invoiced after review) */}
              {isCustom && (
                <div className="px-4 py-3 bg-blue-50 border border-blue-200 rounded-xl">
                  <p className="text-xs font-semibold text-blue-800 m-0 mb-1">
                    Custom capacity request (manual review)
                  </p>
                  <p className="text-xs text-blue-800 m-0 leading-relaxed">
                    The price shown is an <span className="font-semibold">estimate</span>. Your request is
                    manually reviewed within <span className="font-semibold">3 business days</span>, after
                    which we email an invoice with the final amount. You'll have{' '}
                    <span className="font-semibold">14 business days</span> to review and accept it
                    (paying any listed deposit) before the request expires. No payment is taken now.
                  </p>
                </div>
              )}

              {payError && <p className="text-xs text-red-500 m-0">{payError}</p>}
              {busy && <p className="text-xs text-gray-500 m-0">{isCustom ? 'Submitting request…' : 'Verifying payment…'}</p>}

              {/* Custom: submit the request without payment */}
              {isCustom ? (
                <div>
                  <button
                    onClick={handleSubmitCustom}
                    disabled={!canPay}
                    className="w-full px-4 py-3 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50 cursor-pointer transition-colors"
                  >
                    {busy ? 'Submitting…' : `Request ${formatSize(customBytes)} — est. ${formatCents(fullPriceCents)}`}
                  </button>
                  <p className="text-[11px] text-gray-400 text-center m-0 mt-2">
                    Final pricing is confirmed by invoice after review. No charge today.
                  </p>
                </div>
              ) : configLoading ? (
                <p className="text-sm text-gray-400 m-0">Loading payment options…</p>
              ) : !config?.paypal_client_id ? (
                <p className="text-sm text-red-500 m-0">Payments are not configured.</p>
              ) : (
                <div>
                  <p className="text-xs text-gray-500 mb-2 mt-0">
                    {selectedPlanId
                      ? isExpansion
                        ? `Pay deposit: ${formatCents(amountCents)}`
                        : `Pay: ${formatCents(amountCents)}`
                      : 'Select a capacity to continue'}
                  </p>
                  <PayPalCheckoutOptions
                    clientId={config.paypal_client_id}
                    currency={config.currency || 'USD'}
                    environment={config.environment}
                    amount={() => (amountCents / 100).toFixed(2)}
                    createOrder={handleCreateOrder}
                    getApprovalUrl={handleGetApprovalUrl}
                    onApprove={(orderId) => handleApprove({ orderID: orderId })}
                    onError={(msg) => { if (!payError) setPayError(msg) }}
                    canPay={canPay}
                    onChooseCard={() => { setPayError(null); setShowCardForm(true) }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-0 mb-2">{children}</h4>
  )
}

function TierBadge({ type }: { type: 'nvme' | 'hdd' }) {
  return (
    <span className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded ${
      type === 'nvme' ? 'bg-blue-50 text-blue-600' : 'bg-amber-50 text-amber-600'
    }`}>
      {type === 'nvme' ? 'Fast' : 'Standard'}
    </span>
  )
}
