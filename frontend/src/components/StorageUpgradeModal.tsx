import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  PayPalScriptProvider,
  PayPalButtons,
} from '@paypal/react-paypal-js'
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
import {
  STORAGE_PLANS,
  CUSTOM_PLAN_ID,
  CUSTOM_PER_TIB_CENTS,
  TIB,
  buildCustomTibStops,
  captureExpansionOrder,
  captureStorageOrder,
  chargeStorageGooglePay,
  createExpansionOrder,
  createStorageOrder,
  customPriceCents,
  formatCents,
  getBillingConfig,
  submitCustomRequest,
  type StorageType,
} from '../api/billing'
import { ApiError } from '../api/client'
import { useGooglePay } from '../hooks/useGooglePay'
import { GooglePayButton } from './GooglePayButton'

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

interface ServerWithPing extends PublicServer {
  ping_ms: number | null
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
  const { data: user } = useQuery(meQueryOptions)
  const googlePay = useGooglePay()

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: ['billing', 'config'],
    queryFn: getBillingConfig,
    staleTime: 60 * 60 * 1000,
  })

  const { data: servers, isLoading: serversLoading, error: serversError } = useQuery({
    queryKey: ['storage', 'servers', 'with-ping'],
    queryFn: async (): Promise<ServerWithPing[]> => {
      const list = await listServers()
      return Promise.all(
        list.map(async (s) => ({
          ...s,
          ping_ms: await pingServer(s.ping_url).catch(() => null),
          allocated_pct: s.total_capacity_bytes > 0
            ? ((s.total_capacity_bytes - s.available_bytes) / s.total_capacity_bytes) * 100
            : 0,
          row_key: `${s.id}:${s.drive_type}`,
        })),
      )
    },
    staleTime: 60 * 1000,
  })

  const [storageType, setStorageType] = useState<StorageType>('nvme')
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [customStopIdx, setCustomStopIdx] = useState(0)
  const [selectedServerKey, setSelectedServerKey] = useState<string | null>(null)
  const [serverListOpen, setServerListOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>('select')
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

  // Deposit-based expansion request instead of a direct purchase when the
  // server can't take the purchase (>=90% allocated, wrong tier, or not
  // enough free capacity). Custom amounts never pay here: they are submitted
  // without payment (estimated price) and invoiced after manual review.
  const isExpansion = !!selectedPlanId && !isCustom && !!selectedServer &&
    (serverAtCapacity || serverTypeMismatch || serverLacksCapacity)

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

  // Google Pay charges the full price and applies the storage immediately — so
  // it's only offered for in-capacity direct purchases, not the 50%-deposit
  // expansion path or custom (invoiced) requests.
  const canGooglePay = canPay && !isExpansion && !isCustom && googlePay.ready && !!config?.paypal_client_id

  async function handleGooglePayPurchase() {
    if (!selectedPlanId || !selectedServer || isExpansion || isCustom) return
    setBusy(true)
    setPayError(null)
    try {
      const token = await googlePay.requestToken((fullPriceCents / 100).toFixed(2))
      if (!token) return // shopper cancelled the sheet
      const res = await chargeStorageGooglePay(selectedPlanId, storageType, selectedServer.id, token)
      setNewQuota(res.new_quota_bytes)
      setPhase('purchased')
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      queryClient.invalidateQueries({ queryKey: ['storage'] })
      onPurchased?.(res.new_quota_bytes)
    } catch (err) {
      setPayError(err instanceof ApiError ? err.message : 'Google Pay payment failed')
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
          <h3 className="text-base font-semibold text-gray-900 m-0">Add storage</h3>
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

          {phase === 'select' && (
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
                <SectionLabel>Server</SectionLabel>
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
                              {selectedServer.ping_ms != null ? `${selectedServer.ping_ms} ms · ` : ''}
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
                        {servers.map((s) => (
                          <button
                            key={s.row_key}
                            onClick={() => { setSelectedServerKey(s.row_key); setServerListOpen(false) }}
                            className={`flex items-center gap-3 w-full px-4 py-2.5 border-0 cursor-pointer text-left transition-colors ${
                              s.row_key === selectedServerKey ? 'bg-blue-50' : 'bg-transparent hover:bg-gray-50'
                            }`}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className={`text-sm ${s.row_key === selectedServerKey ? 'font-semibold text-blue-700' : 'font-medium text-gray-800'}`}>
                                  {s.name}
                                </span>
                                <TierBadge type={s.drive_type} />
                              </div>
                              <p className="text-xs text-gray-400 m-0 mt-0.5">
                                {s.ping_ms != null ? `${s.ping_ms} ms · ` : ''}
                                {formatSize(s.available_bytes)} available · {s.allocated_pct.toFixed(0)}% allocated
                              </p>
                            </div>
                          </button>
                        ))}
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
                      (serverAtCapacity || selectedServer.drive_type !== storageType || plan.addBytes > selectedServer.available_bytes)
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
                </div>
              </div>

              {/* Expansion notice (fixed plans, deposit-based) */}
              {isExpansion && (
                <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl">
                  <p className="text-xs font-semibold text-amber-800 m-0 mb-1">
                    Capacity expansion request
                  </p>
                  <p className="text-xs text-amber-800 m-0 leading-relaxed">
                    {serverAtCapacity
                      ? `This server is at ${selectedServer?.allocated_pct.toFixed(0)}% allocated capacity, so direct purchases are unavailable. Your request will be reviewed within 7 business days. `
                      : `This server can't fit ${formatSize(planBytes)} of ${storageType === 'nvme' ? 'fast' : 'standard'} storage right now. Your request will be reviewed within 7 business days. `}
                    Once approved, capacity is expanded within <span className="font-semibold">14 business days</span>.
                    You pay a <span className="font-semibold">50% deposit ({formatCents(depositCents)})</span> now;
                    if either deadline is missed, it is refunded automatically. The remaining balance is
                    charged when your capacity is provisioned.
                  </p>
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
                <div className={canPay ? '' : 'opacity-50 pointer-events-none'}>
                  <p className="text-xs text-gray-500 mb-2 mt-0">
                    {selectedPlanId
                      ? isExpansion
                        ? `Pay deposit: ${formatCents(amountCents)}`
                        : `Pay: ${formatCents(amountCents)}`
                      : 'Select a capacity to continue'}
                  </p>
                  {/* Google Pay — direct full-price purchases only (no deposit endpoint). */}
                  {!isExpansion && googlePay.ready && (
                    <>
                      <GooglePayButton
                        onClick={handleGooglePayPurchase}
                        disabled={!canGooglePay || busy}
                        loading={busy}
                        label={`Pay ${formatCents(fullPriceCents)}`}
                        className="w-full flex items-center justify-center gap-2 px-4 py-3 mb-2 text-sm font-semibold bg-white hover:bg-gray-50 text-gray-800 border border-gray-300 rounded-lg disabled:opacity-50 transition-colors cursor-pointer"
                      />
                      <div className="flex items-center gap-2 mb-2 text-[11px] text-gray-400">
                        <span className="flex-1 h-px bg-gray-200" />or<span className="flex-1 h-px bg-gray-200" />
                      </div>
                    </>
                  )}
                  <PayPalScriptProvider
                    options={{
                      clientId: config.paypal_client_id,
                      currency: config.currency || 'USD',
                      intent: 'capture',
                      components: 'buttons',
                    }}
                  >
                    <PayPalButtons
                      disabled={!canPay}
                      style={{ layout: 'vertical', shape: 'rect', label: 'pay' }}
                      createOrder={handleCreateOrder}
                      onApprove={handleApprove}
                      onError={(err) => {
                        if (!payError) setPayError(err instanceof Error ? err.message : 'Payment failed')
                      }}
                      onCancel={() => setPayError(null)}
                    />
                  </PayPalScriptProvider>
                  <p className="text-[11px] text-gray-400 text-center m-0">
                    Payments are processed securely by PayPal.
                  </p>
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
