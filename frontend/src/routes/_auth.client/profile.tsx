import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useCallback, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MdAddCircleOutline, MdCheck, MdClose, MdEdit, MdPhotoLibrary, MdRocketLaunch, MdShield, MdStorage, MdBolt, MdRefresh, MdScience } from 'react-icons/md'
import { FaApple } from 'react-icons/fa'
import { meQueryOptions, updateUsername, preferencesQueryOptions, updatePreferences, updateStorageUIPreferences, updateSandboxPayments, unlinkProvider } from '../../api/me'
import { logout } from '../../api/auth'
import { listRoot } from '../../api/folders'
import { ApiError } from '../../api/client'
import { StorageUpgradeModal } from '../../components/StorageUpgradeModal'
import { PremiumUpgradeModal } from '../../components/PremiumUpgradeModal'
import { AccountBadges } from '../../components/GroupBadge'
import { FileServerLinksCard } from '../../components/FileServerLinksCard'
import { useNotification } from '../../context/NotificationContext'
import { formatCents, listMyExpansionRequests, type ExpansionRequest } from '../../api/billing'
import { useBillingConfig } from '../../hooks/useBillingConfig'
import { cancelPremiumSubscription } from '../../api/payments'
import {
  getStorageBreakdown,
  listMyServers,
  setPrimaryServer,
  pingServer,
  runSpeedTest,
  type SpeedMetrics,
  type MyServer,
} from '../../api/storage'

export const Route = createFileRoute('/_auth/client/profile')({
  component: RouteComponent,
})

const GB = 1024 ** 3

function formatSize(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function RouteComponent() {
  const navigate = useNavigate()
  const { data: user, isLoading } = useQuery(meQueryOptions)

  const [showUpgradeModal, setShowUpgradeModal] = useState(false)
  const [showStorageModal, setShowStorageModal] = useState(false)

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (!user) return null

  const pct = user.storage_quota_bytes > 0
    ? (user.storage_used_bytes / user.storage_quota_bytes) * 100
    : 0
  const barColor = pct >= 90 ? 'bg-red-500' : pct >= 50 ? 'bg-amber-400' : 'bg-green-500'

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-6 mt-0">Profile</h2>

      <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        <UsernameRow currentUsername={user.username} />
        <Row label="Email" value={user.email} />
        <div className="flex items-center justify-between px-5 py-3.5">
          <span className="text-sm text-gray-500">Account type</span>
          <AccountBadges user={user} />
        </div>
        <Row
          label="Member since"
          value={new Date(user.created_at).toLocaleDateString(undefined, {
            year: 'numeric', month: 'long', day: 'numeric',
          })}
        />
        <Row
          label="Last seen"
          value={user.last_seen_at
            ? new Date(user.last_seen_at).toLocaleString()
            : '—'}
        />
        <div className="px-5 py-4">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-gray-500">Storage</span>
            <span className="text-gray-700 font-medium">
              {formatSize(user.storage_used_bytes)}
              <span className="text-gray-400 font-normal"> / {formatSize(user.storage_quota_bytes)}</span>
            </span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${barColor}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-1.5">
            <p className="text-xs text-gray-400 m-0">{pct.toFixed(1)}% used</p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => navigate({ to: '/client/orders' as never })}
                className="text-xs text-gray-500 hover:text-gray-700 bg-transparent border-0 p-0 cursor-pointer font-medium transition-colors"
              >
                My orders
              </button>
              <button
                onClick={() => setShowStorageModal(true)}
                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 bg-transparent border-0 p-0 cursor-pointer font-medium transition-colors"
              >
                <MdAddCircleOutline className="text-sm" /> Add storage
              </button>
            </div>
          </div>
        </div>
      </div>

      {showStorageModal && <StorageUpgradeModal onClose={() => setShowStorageModal(false)} />}

      <ExpansionRequestsCard />

      <StorageInfraCard />

      <LinkedAccountsCard linkedProviders={user.linked_providers} />

      <PremiumCard
        isPremium={user.is_premium}
        isAdmin={user.is_admin}
        sandboxPaymentsEnabled={user.sandbox_payments_enabled}
        grantedAt={user.premium_granted_at}
        premiumSubscribed={user.premium_subscribed}
        premiumEnvironment={user.premium_environment ?? null}
        premiumPlan={user.premium_plan ?? null}
        premiumCurrentPeriodEnd={user.premium_current_period_end ?? null}
        onUpgrade={() => setShowUpgradeModal(true)}
      />
      {showUpgradeModal && <PremiumUpgradeModal onClose={() => setShowUpgradeModal(false)} />}

      {(user.is_premium || user.is_admin) && <FileServerLinksCard />}

      <StorageUIPreferences />

      <MediaAutoUpload />

      {user.is_admin && <SandboxPaymentsToggle enabled={user.sandbox_payments_enabled} />}

      <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-800 m-0">Password</h3>
            <p className="text-xs text-gray-500 m-0 mt-1">
              Changing your password requires a one-time code sent to your email.
            </p>
          </div>
          <button
            onClick={() => navigate({ to: '/client/change-password' as never })}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 text-xs border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 cursor-pointer transition-colors"
          >
            <MdShield className="text-sm text-blue-600" /> Change password
          </button>
        </div>
      </div>
    </div>
  )
}

const SPEED_RATE_LIMIT = 5

function StorageInfraCard() {
  const queryClient = useQueryClient()

  const { data: breakdown, isLoading: breakdownLoading } = useQuery({
    queryKey: ['storage', 'breakdown'],
    queryFn: getStorageBreakdown,
  })

  const { data: myServers = [] } = useQuery({
    queryKey: ['storage', 'my-servers'],
    queryFn: listMyServers,
  })

  const [primaryPingMs, setPrimaryPingMs] = useState<number | null>(null)
  const [primaryTesting, setPrimaryTesting] = useState(false)
  const [settingPrimary, setSettingPrimary] = useState<string | null>(null)

  const [speed, setSpeed] = useState<SpeedMetrics | null>(null)
  const [speedLoading, setSpeedLoading] = useState(false)
  const [speedError, setSpeedError] = useState<string | null>(null)
  const speedCallsRef = useRef<number[]>([])
  const [speedRemaining, setSpeedRemaining] = useState(SPEED_RATE_LIMIT)

  const testPrimaryConnection = useCallback(async (servers: MyServer[]) => {
    const primary = servers.find((s) => s.is_primary)
    if (!primary) { setPrimaryPingMs(null); return }
    setPrimaryTesting(true)
    try {
      setPrimaryPingMs(await pingServer(primary.ping_url))
    } catch {
      setPrimaryPingMs(null)
    } finally {
      setPrimaryTesting(false)
    }
  }, [])

  useEffect(() => {
    if (myServers.length > 0) testPrimaryConnection(myServers)
  }, [myServers, testPrimaryConnection])

  const runSpeed = useCallback(async () => {
    if (speedLoading) return
    const now = Date.now()
    speedCallsRef.current = speedCallsRef.current.filter((t) => now - t < 60_000)
    const remaining = SPEED_RATE_LIMIT - speedCallsRef.current.length
    setSpeedRemaining(remaining)
    if (remaining <= 0) {
      setSpeedError('Limit reached. Try again in a minute.')
      return
    }
    setSpeedLoading(true)
    setSpeedError(null)
    speedCallsRef.current.push(Date.now())
    setSpeedRemaining(SPEED_RATE_LIMIT - speedCallsRef.current.length)
    const pingUrl = breakdown?.server?.ping_url ?? '/api/v1/storage/servers'
    try {
      const result = await runSpeedTest(pingUrl)
      setSpeed(result)
    } catch (e: any) {
      if (e?.code === 'RATE_LIMITED') {
        setSpeedError('Limit reached. Try again in a minute.')
      } else {
        setSpeedError('Speed test failed. Check your connection.')
      }
    } finally {
      setSpeedLoading(false)
      const t = Date.now()
      speedCallsRef.current = speedCallsRef.current.filter((x) => t - x < 60_000)
      setSpeedRemaining(SPEED_RATE_LIMIT - speedCallsRef.current.length)
    }
  }, [speedLoading, breakdown])

  // Auto-run once when breakdown first loads
  useEffect(() => {
    if (breakdown && !speed && !speedLoading) runSpeed()
  }, [breakdown]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectPrimary = useCallback(async (srv: MyServer) => {
    if (srv.is_primary || settingPrimary) return
    setSettingPrimary(srv.server_id)
    try {
      await setPrimaryServer(srv.server_id)
      queryClient.invalidateQueries({ queryKey: ['storage', 'my-servers'] })
    } catch {
      // keep previous selection on failure
    } finally {
      setSettingPrimary(null)
    }
  }, [settingPrimary, queryClient])

  const allocatedBytes = breakdown?.quota_bytes ?? 0
  const ownedTypes = new Set(myServers.map((s) => s.drive_type))
  const showNvme = ownedTypes.size === 0 || ownedTypes.has('nvme')
  const showHdd = ownedTypes.size === 0 || ownedTypes.has('hdd')
  const nvmePct = breakdown && breakdown.quota_bytes > 0
    ? Math.min((breakdown.nvme_bytes / breakdown.quota_bytes) * 100, 100) : 0
  const hddPct = breakdown && breakdown.quota_bytes > 0
    ? Math.min((breakdown.hdd_bytes / breakdown.quota_bytes) * 100, 100) : 0

  return (
    <>
      {/* Storage + Servers card */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4">
          <h3 className="text-sm font-semibold text-gray-800 mb-3">Your Storage Infrastructure</h3>

          {breakdownLoading && !breakdown ? (
            <p className="text-sm text-gray-400">Loading…</p>
          ) : breakdown ? (
            <div className="flex flex-col gap-3">
              {showNvme && (
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                    <MdBolt className="text-blue-600 text-sm" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-gray-500">Fast storage (NVMe)</span>
                      <span className="text-gray-700 font-medium">{formatSize(breakdown.nvme_bytes)}</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${nvmePct}%` }} />
                    </div>
                  </div>
                </div>
              )}
              {showHdd && (
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
                    <MdStorage className="text-amber-500 text-sm" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-gray-500">Standard storage (HDD)</span>
                      <span className="text-gray-700 font-medium">{formatSize(breakdown.hdd_bytes)}</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-amber-400 transition-all" style={{ width: `${hddPct}%` }} />
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-400">Could not load storage info.</p>
          )}
        </div>

        {myServers.length > 0 && (
          <>
            <div className="border-t border-gray-100" />
            <div className="px-5 py-4">
              <h3 className="text-sm font-semibold text-gray-800 mb-2">Servers</h3>
              {myServers.length > 1 && (
                <p className="text-xs text-gray-400 mb-3">
                  Uploads go to your primary server, falling back to the least-full one when it's full.
                </p>
              )}
              <div className="divide-y divide-gray-100">
                {myServers.map((srv) => (
                  <button
                    key={srv.server_id}
                    onClick={() => handleSelectPrimary(srv)}
                    disabled={srv.is_primary || settingPrimary !== null}
                    className={`flex items-center gap-3 py-3 text-left w-full bg-transparent border-0 transition-colors ${
                      !srv.is_primary && settingPrimary === null
                        ? 'cursor-pointer hover:bg-gray-50'
                        : 'cursor-default'
                    }`}
                  >
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                      srv.drive_type === 'nvme' ? 'bg-blue-50' : 'bg-amber-50'
                    }`}>
                      {srv.drive_type === 'nvme'
                        ? <MdBolt className="text-blue-600 text-sm" />
                        : <MdStorage className="text-amber-500 text-sm" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-sm font-medium text-gray-800">{srv.name}</span>
                        <span className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded ${
                          srv.drive_type === 'nvme' ? 'bg-blue-50 text-blue-600' : 'bg-amber-50 text-amber-600'
                        }`}>
                          {srv.drive_type === 'nvme' ? 'Fast' : 'Standard'}
                        </span>
                        {srv.is_primary && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-blue-50 text-blue-600 rounded">
                            Primary
                          </span>
                        )}
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-1.5">
                        <div
                          className={`h-full rounded-full transition-all ${srv.drive_type === 'nvme' ? 'bg-blue-500' : 'bg-amber-400'}`}
                          style={{ width: `${allocatedBytes > 0 ? Math.min((srv.used_bytes / allocatedBytes) * 100, 100) : 0}%` }}
                        />
                      </div>
                      <p className="text-xs text-gray-400 m-0">
                        {formatSize(srv.used_bytes)} used of {formatSize(allocatedBytes)}
                        {srv.is_primary && (
                          primaryTesting
                            ? ' · Testing…'
                            : primaryPingMs != null
                              ? ` · ${primaryPingMs} ms`
                              : ''
                        )}
                      </p>
                    </div>
                    <div className="shrink-0">
                      {settingPrimary === srv.server_id ? (
                        <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                      ) : srv.is_primary ? (
                        <MdCheck className="text-blue-600 text-lg" />
                      ) : (
                        <div className="w-4 h-4 rounded-full border-2 border-gray-300" />
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Connection card */}
      {breakdown?.server && (
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-gray-800">Connection</h3>
              <p className="text-xs text-gray-400 m-0 mt-0.5 truncate">
                Testing to <span className="font-medium text-gray-500">{breakdown.server.name}</span>
              </p>
            </div>
            <button
              onClick={runSpeed}
              disabled={speedLoading || speedRemaining <= 0}
              title="Re-run speed test"
              className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
                speedLoading || speedRemaining <= 0
                  ? 'bg-gray-100 text-gray-300 cursor-not-allowed'
                  : 'bg-blue-50 text-blue-600 hover:bg-blue-100 cursor-pointer'
              }`}
            >
              <MdRefresh className={`text-base ${speedLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {speedRemaining < SPEED_RATE_LIMIT && !speedLoading && (
            <p className="text-xs text-gray-400 mb-3">
              {speedRemaining > 0
                ? `${speedRemaining} refresh${speedRemaining !== 1 ? 'es' : ''} remaining this minute`
                : 'Limit reached — try again in a minute'}
            </p>
          )}

          {speedError && <p className="text-xs text-red-500 mb-3">{speedError}</p>}

          <div className="grid grid-cols-3 divide-x divide-gray-100 mt-1">
            <div className="flex flex-col items-center py-2">
              <span className="text-2xl font-bold text-gray-900 leading-none">
                {speedLoading ? '—' : speed?.ping_ms != null ? speed.ping_ms : '—'}
              </span>
              <span className="text-xs text-gray-400 mt-0.5 h-4">
                {!speedLoading && speed?.ping_ms != null ? 'ms' : ''}
              </span>
              <span className="text-xs text-gray-500 mt-1">Ping</span>
            </div>
            <div className="flex flex-col items-center py-2">
              <span className="text-2xl font-bold text-gray-900 leading-none">
                {speedLoading ? '—' : speed?.download_mbps != null
                  ? speed.download_mbps >= 1000
                    ? (speed.download_mbps / 1000).toFixed(1)
                    : speed.download_mbps.toFixed(1)
                  : '—'}
              </span>
              <span className="text-xs text-gray-400 mt-0.5 h-4">
                {!speedLoading && speed?.download_mbps != null
                  ? speed.download_mbps >= 1000 ? 'Gbps' : 'Mbps'
                  : ''}
              </span>
              <span className="text-xs text-gray-500 mt-1">Download</span>
            </div>
            <div className="flex flex-col items-center py-2">
              <span className="text-2xl font-bold text-gray-900 leading-none">
                {speedLoading ? '—' : speed?.upload_mbps != null
                  ? speed.upload_mbps >= 1000
                    ? (speed.upload_mbps / 1000).toFixed(1)
                    : speed.upload_mbps.toFixed(1)
                  : '—'}
              </span>
              <span className="text-xs text-gray-400 mt-0.5 h-4">
                {!speedLoading && speed?.upload_mbps != null
                  ? speed.upload_mbps >= 1000 ? 'Gbps' : 'Mbps'
                  : ''}
              </span>
              <span className="text-xs text-gray-500 mt-1">Upload</span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── Storage upgrades ──────────────────────────────────────────────────────────

const EXPANSION_STATUS_META: Record<ExpansionRequest['status'], { label: string; className: string }> = {
  opened:       { label: 'Awaiting review',  className: 'bg-amber-50 text-amber-700' },
  invoice_sent: { label: 'Invoice sent',     className: 'bg-blue-50 text-blue-700' },
  accepted:     { label: 'Invoice accepted', className: 'bg-blue-50 text-blue-700' },
  approved:     { label: 'Approved',         className: 'bg-blue-50 text-blue-700' },
  expanded:     { label: 'Balance due',      className: 'bg-purple-50 text-purple-700' },
  completed:    { label: 'Completed',        className: 'bg-green-50 text-green-700' },
  expired:      { label: 'Expired',          className: 'bg-gray-100 text-gray-500' },
  refunded:     { label: 'Refunded',         className: 'bg-gray-100 text-gray-500' },
  rejected:     { label: 'Rejected',         className: 'bg-red-50 text-red-600' },
}

function expansionCapacityLabel(r: ExpansionRequest): string {
  const tib = 1024 ** 4
  if (r.bytes_requested >= 1024 * tib) return `${(r.bytes_requested / (1024 * tib)).toFixed(1).replace(/\.0$/, '')} PB`
  if (r.bytes_requested >= tib) return `${(r.bytes_requested / tib).toFixed(1).replace(/\.0$/, '')} TB`
  return `${Math.round(r.bytes_requested / 1024 ** 3)} GB`
}

function ExpansionRequestsCard() {
  const navigate = useNavigate()
  const { data: requests } = useQuery({
    queryKey: ['billing', 'expansion-requests'],
    queryFn: listMyExpansionRequests,
  })

  if (!Array.isArray(requests) || requests.length === 0) return null

  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-gray-800 m-0">Capacity expansion requests</h3>
        <button
          onClick={() => navigate({ to: '/client/orders' as never })}
          className="text-xs text-blue-600 hover:text-blue-700 bg-transparent border-0 p-0 cursor-pointer font-medium transition-colors"
        >
          View all orders
        </button>
      </div>
      <p className="text-xs text-gray-400 mb-3">
        Requests are reviewed within 7 business days (3 for custom capacity) and expanded within
        14 business days of approval. Your deposit is refunded automatically if either deadline is missed.
      </p>
      <div className="divide-y divide-gray-100">
        {requests.map((r) => {
          const meta = EXPANSION_STATUS_META[r.status] ?? { label: r.status, className: 'bg-gray-100 text-gray-500' }
          const deadline =
            r.status === 'opened' ? { label: 'Review due', at: r.approval_due_at ?? r.expires_at }
            : r.status === 'invoice_sent' ? { label: 'Accept invoice by', at: r.invoice_accept_due_at ?? null }
            : r.status === 'accepted' ? { label: 'Approval due', at: r.approval_due_at }
            : r.status === 'approved' ? { label: 'Expansion due', at: r.expansion_due_at }
            : r.status === 'expanded' ? { label: 'Balance due since', at: r.payment_due_at }
            : null
          return (
            <div key={r.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-800">
                  {expansionCapacityLabel(r)} {r.storage_type === 'nvme' ? 'Fast' : 'Standard'}
                  {r.is_custom ? ' (custom)' : ''}
                </span>
                <span className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded ${meta.className}`}>
                  {meta.label}
                </span>
              </div>
              <p className="text-xs text-gray-400 m-0 mt-1">
                {r.server_name} · deposit {formatCents(r.deposit_amount_cents)} of {formatCents(r.full_price_cents)} ·
                requested {new Date(r.created_at).toLocaleDateString()}
                {deadline?.at && <> · {deadline.label} {new Date(deadline.at).toLocaleDateString()}</>}
              </p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StorageUIPreferences() {
  const queryClient = useQueryClient()
  const { data: prefs } = useQuery(preferencesQueryOptions)
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: updateStorageUIPreferences,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['preferences'] })
      setError(null)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to save preference'),
  })

  const showButtons = prefs?.show_storage_buttons ?? true
  const promptEnabled = prefs?.storage_prompt_enabled ?? true

  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
      <h3 className="text-sm font-semibold text-gray-800 mb-1 flex items-center gap-1.5">
        <MdAddCircleOutline className="text-gray-500" /> Storage upgrades
      </h3>
      <p className="text-xs text-gray-400 mb-4">
        Control where the add-storage shortcuts appear. You can always add storage from this page.
      </p>
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={showButtons}
            onChange={(e) => mutation.mutate({ show_storage_buttons: e.target.checked })}
            className="cursor-pointer"
          />
          Show &ldquo;+&rdquo; add-storage buttons on the home page and upload dialog
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={promptEnabled}
            onChange={(e) => mutation.mutate({ storage_prompt_enabled: e.target.checked })}
            className="cursor-pointer"
          />
          Offer more storage when an upload passes 75% of my quota or exceeds it
        </label>
        {error && <p className="text-xs text-red-500 m-0">{error}</p>}
      </div>
    </div>
  )
}

function SandboxPaymentsToggle({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: updateSandboxPayments,
    onSuccess: () => {
      // Both queries encode the toggle's effect (which PayPal environment is
      // "sandbox" for this session) — invalidating only 'me' left billing
      // config's 1-hour cache serving a stale environment after the toggle
      // flipped or across a logout/login cycle.
      queryClient.invalidateQueries({ queryKey: ['me'] })
      queryClient.invalidateQueries({ queryKey: ['billing', 'config'] })
      setError(null)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to save preference'),
  })

  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
      <h3 className="text-sm font-semibold text-gray-800 mb-1 flex items-center gap-1.5">
        <MdScience className="text-gray-500" /> Sandbox payments
      </h3>
      <p className="text-xs text-gray-400 mb-4">
        Route your own premium, storage, and expansion purchases through the PayPal sandbox
        instead of live PayPal, so you can test checkout flows safely. Resets to off when you
        log out or your session expires.
      </p>
      <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => mutation.mutate(e.target.checked)}
          className="cursor-pointer"
        />
        Use PayPal sandbox for my purchases this session
      </label>
      {error && <p className="text-xs text-red-500 m-0 mt-2">{error}</p>}
    </div>
  )
}

function MediaAutoUpload() {
  const queryClient = useQueryClient()
  const { data: prefs } = useQuery(preferencesQueryOptions)
  const { data: root } = useQuery({ queryKey: ['folders', 'root'], queryFn: () => listRoot() })
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const mediaFolders = (root?.subfolders?.items ?? []).filter((f) => f.kind === 'media')
  const enabled = !!prefs?.media_autoupload_folder_id

  const mutation = useMutation({
    mutationFn: (folderId: string | null) => updatePreferences(folderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['preferences'] })
      setError(null)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to save preference'),
  })

  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
      <h3 className="text-sm font-semibold text-gray-800 mb-1 flex items-center gap-1.5">
        <MdPhotoLibrary className="text-gray-500" /> Media auto-upload
      </h3>
      <p className="text-xs text-gray-400 mb-4">
        Automatically send every photo and video you upload to a chosen media collection.
      </p>

      {mediaFolders.length === 0 ? (
        <p className="text-xs text-gray-500">
          Create a media collection first to enable auto-upload.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => mutation.mutate(e.target.checked ? mediaFolders[0].id : null)}
              className="cursor-pointer"
            />
            Auto-upload photos &amp; videos to a collection
          </label>

          {enabled && (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Destination collection</label>
              <select
                value={prefs?.media_autoupload_folder_id ?? ''}
                onChange={(e) => mutation.mutate(e.target.value || null)}
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent cursor-pointer"
              >
                {mediaFolders.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}
          {saved && <p className="text-xs text-green-600">Preference saved.</p>}
        </div>
      )}
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  )
}

function LinkedAccountsCard({ linkedProviders }: { linkedProviders: string[] }) {
  const queryClient = useQueryClient()
  const [unlinking, setUnlinking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const providers = [
    { key: 'google', label: 'Google', icon: <GoogleIcon /> },
    { key: 'apple',  label: 'Apple',  icon: <FaApple className="text-gray-900 text-lg" /> },
  ]

  const handleUnlink = async (provider: string) => {
    setUnlinking(provider)
    setError(null)
    try {
      await unlinkProvider(provider)
      queryClient.invalidateQueries({ queryKey: ['me'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlink account')
    } finally {
      setUnlinking(null)
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
      <h3 className="text-sm font-semibold text-gray-800 mb-3">Linked accounts</h3>
      <div className="flex flex-col divide-y divide-gray-100">
        {providers.map(({ key, label, icon }) => {
          const linked = linkedProviders.includes(key)
          return (
            <div key={key} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <span className="w-5 flex items-center justify-center shrink-0">{icon}</span>
              <span className="text-sm text-gray-700 flex-1">{label}</span>
              {linked ? (
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-xs font-medium text-green-600">
                    <MdCheck className="shrink-0" /> Connected
                  </span>
                  <button
                    onClick={() => handleUnlink(key)}
                    disabled={unlinking !== null}
                    className="text-xs text-gray-400 hover:text-red-500 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {unlinking === key ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              ) : (
                <span className="text-xs text-gray-400">Not connected</span>
              )}
            </div>
          )
        })}
      </div>
      {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-5 py-3.5">
      <span className="text-sm text-gray-500">{label}</span>
      <span className="text-sm text-gray-900 font-medium">{value}</span>
    </div>
  )
}

// UsernameRow shows the current username with inline editing. Because a rename
// only takes effect for the current session on the next token refresh, a
// successful change signs the user out so they log back in with the new name.
function UsernameRow({ currentUsername }: { currentUsername: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { notify } = useNotification()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(currentUsername)
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => updateUsername(value.trim()),
    onSuccess: async () => {
      notify('success', 'Username updated — please sign in again')
      // The current token still holds the old username; sign out so the next
      // login mints a token with the new identity.
      try { await logout() } catch { /* ignore — redirect regardless */ }
      queryClient.clear()
      navigate({ to: '/login', search: { social_error: undefined, link_provider: undefined, link_email: undefined, link_username: undefined } })
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to update username'),
  })

  const trimmed = value.trim()
  const valid = trimmed.length >= 3 && trimmed.length <= 150 && trimmed !== currentUsername

  if (!editing) {
    return (
      <div className="flex items-center justify-between px-5 py-3.5">
        <span className="text-sm text-gray-500">Username</span>
        <span className="flex items-center gap-2">
          <span className="text-sm text-gray-900 font-medium">{currentUsername}</span>
          <button
            onClick={() => { setValue(currentUsername); setError(null); setEditing(true) }}
            title="Edit username"
            className="text-gray-400 hover:text-blue-600 cursor-pointer bg-transparent border-0 p-0 transition-colors"
          >
            <MdEdit className="text-base" />
          </button>
        </span>
      </div>
    )
  }

  return (
    <div className="px-5 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-gray-500 shrink-0">Username</span>
        <div className="flex items-center gap-1.5 flex-1 justify-end">
          <input
            autoFocus
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(null) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && valid && !mutation.isPending) mutation.mutate()
              if (e.key === 'Escape') { setEditing(false); setValue(currentUsername) }
            }}
            className="w-48 max-w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button
            onClick={() => mutation.mutate()}
            disabled={!valid || mutation.isPending}
            title="Save username"
            className="text-green-500 hover:text-green-700 disabled:opacity-30 cursor-pointer bg-transparent border-0 p-1 transition-colors"
          >
            <MdCheck className="text-lg" />
          </button>
          <button
            onClick={() => { setEditing(false); setValue(currentUsername); setError(null) }}
            title="Cancel"
            className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-1 transition-colors"
          >
            <MdClose className="text-lg" />
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-400 m-0 mt-1.5 text-right">
        Changing your username signs you out; log back in with the new name.
      </p>
      {error && <p className="text-xs text-red-500 m-0 mt-1 text-right">{error}</p>}
    </div>
  )
}

function PremiumCard({
  isPremium, isAdmin, sandboxPaymentsEnabled, grantedAt,
  premiumSubscribed, premiumEnvironment, premiumPlan, premiumCurrentPeriodEnd,
  onUpgrade,
}: {
  isPremium: boolean
  isAdmin: boolean
  sandboxPaymentsEnabled: boolean
  grantedAt: string | null
  premiumSubscribed: boolean
  premiumEnvironment: 'sandbox' | 'live' | null
  premiumPlan: 'monthly' | 'annual' | null
  premiumCurrentPeriodEnd: string | null
  onUpgrade: () => void
}) {
  const queryClient = useQueryClient()
  const { data: billingConfig } = useBillingConfig()
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  const cancelMutation = useMutation({
    mutationFn: cancelPremiumSubscription,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['me'] })
      setConfirmingCancel(false)
    },
    onError: (err) => setCancelError(err instanceof ApiError ? err.message : 'Could not cancel subscription'),
  })

  // Admins are implicitly premium — but a non-admin's is_premium always
  // reflects a real grant of their own (subscription or legacy one-time
  // purchase), so only admins need the extra premiumSubscribed check to tell
  // a genuine subscription apart from the implicit admin grant.
  const genuinelyPremium = isAdmin ? premiumSubscribed : isPremium

  // When sandbox payments mode is on, show the real upgrade flow so it can
  // actually be tested end-to-end even for an admin.
  if (genuinelyPremium || (isAdmin && !sandboxPaymentsEnabled)) {
    const planPrice = billingConfig?.premium_plans?.find((p) => p.plan === premiumPlan)?.price_cents
    const periodEnd = premiumCurrentPeriodEnd ? new Date(premiumCurrentPeriodEnd) : null
    const daysLeft = periodEnd ? Math.max(0, Math.ceil((periodEnd.getTime() - Date.now()) / 86_400_000)) : null

    return (
      <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
        <div className="flex items-start gap-3">
          <MdCheck className="text-green-500 text-xl shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-800 m-0">Premium</h3>
              {premiumSubscribed && premiumEnvironment === 'sandbox' && (
                <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-purple-100 text-purple-700 rounded">
                  Sandbox
                </span>
              )}
            </div>
            {premiumSubscribed ? (
              <div className="text-xs text-gray-500 mt-1 flex flex-col gap-0.5">
                {periodEnd && (
                  <p className="m-0">
                    Renews {periodEnd.toLocaleDateString()}
                    {daysLeft !== null ? ` (${daysLeft} day${daysLeft === 1 ? '' : 's'})` : ''}
                  </p>
                )}
                {planPrice !== undefined && periodEnd && (
                  <p className="m-0">Next payment: {formatCents(planPrice)} on {periodEnd.toLocaleDateString()}</p>
                )}
              </div>
            ) : (
              <p className="text-xs text-gray-500 m-0 mt-1">
                {isAdmin
                  ? 'Included with your admin account.'
                  : grantedAt ? `Since ${new Date(grantedAt).toLocaleDateString()}.` : 'Active.'}
              </p>
            )}
          </div>
        </div>

        {premiumSubscribed && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            {!confirmingCancel ? (
              <button
                onClick={() => { setCancelError(null); setConfirmingCancel(true) }}
                className="text-xs text-red-500 hover:text-red-600 cursor-pointer bg-transparent border-0 p-0 transition-colors"
              >
                Cancel Premium Membership
              </button>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-gray-600 m-0">
                  This immediately revokes access — your SFS API keys and file-server links stop
                  working right away. You&rsquo;d need to subscribe again to restore access.
                </p>
                {cancelError && <p className="text-xs text-red-500 m-0">{cancelError}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={() => cancelMutation.mutate()}
                    disabled={cancelMutation.isPending}
                    className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium disabled:opacity-50 cursor-pointer transition-colors"
                  >
                    {cancelMutation.isPending ? 'Cancelling…' : 'Yes, cancel membership'}
                  </button>
                  <button
                    onClick={() => setConfirmingCancel(false)}
                    disabled={cancelMutation.isPending}
                    className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50 cursor-pointer transition-colors"
                  >
                    Never mind
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // Premium checkout is still being verified end-to-end — only surface the
  // upgrade card while payments are routed through the PayPal sandbox
  // (globally, via PAYPAL_ENV, or per-admin via the sandbox-payments toggle
  // above). Hidden entirely otherwise so real users aren't steered into an
  // unverified live payment flow.
  if (billingConfig?.environment !== 'sandbox') {
    return null
  }

  return (
    <div className="bg-amber-50 border-2 border-amber-200 rounded-xl px-5 py-4">
      <div className="flex items-start gap-3">
        <MdRocketLaunch className="text-amber-500 text-2xl shrink-0 mt-0.5" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-gray-900 m-0">Upgrade to Premium</h3>
        </div>
        <button
          onClick={onUpgrade}
          className="px-3 py-2 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
        >
          Upgrade
        </button>
      </div>
    </div>
  )
}

