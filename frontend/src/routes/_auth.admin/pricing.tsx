import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import {
  MdAdd,
  MdChevronLeft,
  MdChevronRight,
  MdClose,
  MdDelete,
  MdEvent,
  MdLocalOffer,
  MdSave,
  MdStorage,
} from 'react-icons/md'
import {
  createPricingDiscount,
  createPricingItem,
  deletePricingDiscount,
  deletePricingItem,
  discountedCents,
  discountPercentFor,
  getServerPricing,
  listPricingServers,
  resolveDiscount,
  updatePricingItem,
  type CreateDiscountInput,
  type DiscountMode,
  type DiscountScope,
  type NotifyGroup,
  type PricingDiscount,
  type PricingItem,
  type PricingServer,
} from '../../api/pricing'
import { formatCents, type StorageType } from '../../api/billing'
import { DiscountBadge, DiscountCountdown, MarkedDownPrice } from '../../components/DiscountBadge'
import { useNotification } from '../../context/NotificationContext'

export const Route = createFileRoute('/_auth/admin/pricing')({
  component: RouteComponent,
})

const GB = 1024 ** 3
const TB = 1024 ** 4

const TIER_LABELS: Record<StorageType, string> = {
  nvme: 'Fast (NVMe)',
  hdd: 'Standard (HDD)',
}

function formatBytesLabel(bytes: number): string {
  if (bytes >= TB) {
    const tb = bytes / TB
    return `${Number.isInteger(tb) ? tb : tb.toFixed(2).replace(/\.?0+$/, '')} TB`
  }
  return `${Math.round(bytes / GB)} GB`
}

// Quantity editor state: value + unit, convertible to bytes.
interface QtyDraft {
  qty: string
  unit: 'GB' | 'TB'
  price: string // dollars
}

function draftFromItem(item: PricingItem): QtyDraft {
  const useTB = item.bytes >= TB
  const qty = useTB ? item.bytes / TB : item.bytes / GB
  return {
    qty: String(Number.isInteger(qty) ? qty : Number(qty.toFixed(2))),
    unit: useTB ? 'TB' : 'GB',
    price: (item.price_cents / 100).toFixed(2),
  }
}

function draftBytes(d: QtyDraft): number {
  const n = parseFloat(d.qty)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * (d.unit === 'TB' ? TB : GB))
}

function draftCents(d: QtyDraft): number {
  const n = parseFloat(d.price)
  if (!Number.isFinite(n) || n < 0) return -1
  return Math.round(n * 100)
}

// A pending discount awaiting confirmation (expiry / notifications / premium).
interface PendingDiscount {
  scope: DiscountScope
  storageType?: StorageType
  itemId?: string
  mode: DiscountMode
  // percent 1–99 for percent mode; reduced price in cents for price mode.
  value: number
}

function RouteComponent() {
  const queryClient = useQueryClient()
  const { notify } = useNotification()

  const [serverId, setServerId] = useState<string>('')
  const [discounting, setDiscounting] = useState(false)
  const [discountMode, setDiscountMode] = useState<DiscountMode>('percent')
  const [pending, setPending] = useState<PendingDiscount | null>(null)

  const serversQuery = useQuery({
    queryKey: ['admin', 'pricing', 'servers'],
    queryFn: listPricingServers,
  })
  const servers = serversQuery.data ?? []

  // Default to the first server once loaded.
  useEffect(() => {
    if (!serverId && servers.length > 0) setServerId(servers[0].id)
  }, [servers, serverId])

  const pricingQuery = useQuery({
    queryKey: ['admin', 'pricing', serverId],
    queryFn: () => getServerPricing(serverId),
    enabled: !!serverId,
  })

  const server = servers.find((s) => s.id === serverId)
  const items = pricingQuery.data?.items ?? []
  const discounts = pricingQuery.data?.discounts ?? []

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'pricing', serverId] })
  }

  const deleteDiscountMutation = useMutation({
    mutationFn: deletePricingDiscount,
    onSuccess: () => {
      invalidate()
      notify('success', 'Discount removed')
    },
    onError: () => notify('error', 'Failed to remove discount'),
  })

  // Tiers shown: every tier the server physically offers, plus any tier that
  // already has line items (covers drives deactivated after items were made).
  const tiers = useMemo(() => {
    const set = new Set<StorageType>(server?.tiers ?? [])
    for (const it of items) set.add(it.storage_type)
    return (['nvme', 'hdd'] as StorageType[]).filter((t) => set.has(t))
  }, [server, items])

  const serverDiscount = discounts.find((d) => d.scope === 'server')

  if (serversQuery.isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (serversQuery.error) return <p className="text-sm text-red-500">Failed to load servers.</p>

  return (
    <div className="max-w-5xl">
      {/* ── Header: title + server picker ─────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-900 m-0">Product Pricing</h2>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <MdStorage className="text-gray-400" />
          Server
          <select
            value={serverId}
            onChange={(e) => setServerId(e.target.value)}
            className="border border-gray-200 rounded-md px-2 py-1.5 text-sm bg-white cursor-pointer"
          >
            {servers.map((s: PricingServer) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.is_active ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* ── Discounting bar ───────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 px-4 py-3 mb-4 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <button
            role="switch"
            aria-checked={discounting}
            onClick={() => setDiscounting((v) => !v)}
            className={`relative w-10 h-5.5 rounded-full transition-colors cursor-pointer ${discounting ? 'bg-green-600' : 'bg-gray-300'}`}
            style={{ height: 22 }}
          >
            <span
              className={`absolute top-0.5 w-4.5 h-4.5 bg-white rounded-full shadow transition-transform ${discounting ? 'translate-x-5' : 'translate-x-0.5'}`}
              style={{ width: 18, height: 18 }}
            />
          </button>
          <span className="text-sm font-medium text-gray-800 flex items-center gap-1">
            <MdLocalOffer className={discounting ? 'text-green-600' : 'text-gray-400'} />
            Discounting
          </span>
        </label>

        {discounting && (
          <div className="flex items-center gap-1 text-xs">
            {(['percent', 'price'] as DiscountMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setDiscountMode(m)}
                className={`px-3 py-1.5 rounded-md border cursor-pointer transition-colors ${
                  discountMode === m
                    ? 'bg-green-600 text-white border-green-600'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                }`}
              >
                {m === 'percent' ? 'Percentage' : 'Reduced price'}
              </button>
            ))}
            <span className="ml-2 text-gray-400">
              {discountMode === 'percent'
                ? 'Pick a % off — the marked-down price is shown per item.'
                : 'Set a reduced price — the % deduction is calculated per item.'}
            </span>
          </div>
        )}
      </div>

      {/* ── Server-level discount ─────────────────────────────────────────── */}
      {discounting && server && (
        <DiscountControl
          label={`Entire server — ${server.name}`}
          mode={discountMode}
          onApply={(value) => setPending({ scope: 'server', mode: discountMode, value })}
          className="mb-4"
        />
      )}
      {serverDiscount && (
        <ActiveDiscountChip
          discount={serverDiscount}
          label={`Whole server${server ? ` — ${server.name}` : ''}`}
          onRemove={() => deleteDiscountMutation.mutate(serverDiscount.id)}
          onExpired={invalidate}
          className="mb-4"
        />
      )}

      {pricingQuery.isLoading && <p className="text-sm text-gray-500">Loading pricing…</p>}
      {!!pricingQuery.error && <p className="text-sm text-red-500">Failed to load pricing.</p>}

      {/* ── Tier sections ─────────────────────────────────────────────────── */}
      {!pricingQuery.isLoading && tiers.length === 0 && (
        <p className="text-sm text-gray-400">This server has no active drives — no tiers to price.</p>
      )}
      {tiers.map((tier) => (
        <TierSection
          key={`${serverId}:${tier}`}
          serverId={serverId}
          tier={tier}
          items={items.filter((i) => i.storage_type === tier)}
          discounts={discounts}
          discounting={discounting}
          discountMode={discountMode}
          onProposeDiscount={setPending}
          onRemoveDiscount={(id) => deleteDiscountMutation.mutate(id)}
          onChanged={invalidate}
        />
      ))}

      {/* ── Discount confirmation ─────────────────────────────────────────── */}
      {pending && server && (
        <DiscountConfirmModal
          pending={pending}
          server={server}
          items={items}
          onClose={() => setPending(null)}
          onCreated={(notified) => {
            setPending(null)
            invalidate()
            notify(
              'success',
              notified > 0 ? `Discount created — ${notified} user${notified === 1 ? '' : 's'} notified` : 'Discount created',
            )
          }}
          onError={(msg) => notify('error', msg)}
        />
      )}
    </div>
  )
}

// ── Tier section ─────────────────────────────────────────────────────────────

interface TierSectionProps {
  serverId: string
  tier: StorageType
  items: PricingItem[]
  discounts: PricingDiscount[]
  discounting: boolean
  discountMode: DiscountMode
  onProposeDiscount: (p: PendingDiscount) => void
  onRemoveDiscount: (id: string) => void
  onChanged: () => void
}

function TierSection({
  serverId, tier, items, discounts, discounting, discountMode,
  onProposeDiscount, onRemoveDiscount, onChanged,
}: TierSectionProps) {
  const { notify } = useNotification()
  const tierDiscount = discounts.find((d) => d.scope === 'tier' && d.storage_type === tier)

  const [adding, setAdding] = useState(false)
  const [addDraft, setAddDraft] = useState<QtyDraft>({ qty: '', unit: 'GB', price: '' })

  const createMutation = useMutation({
    mutationFn: () =>
      createPricingItem({
        server_id: serverId,
        storage_type: tier,
        bytes: draftBytes(addDraft),
        price_cents: draftCents(addDraft),
        sort_order: items.length,
      }),
    onSuccess: () => {
      setAdding(false)
      setAddDraft({ qty: '', unit: 'GB', price: '' })
      onChanged()
      notify('success', 'Line item added')
    },
    onError: (e: Error) => notify('error', e.message || 'Failed to add line item'),
  })

  const addValid = draftBytes(addDraft) > 0 && draftCents(addDraft) >= 0

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <h3 className="text-sm font-semibold text-gray-800 m-0">{TIER_LABELS[tier]}</h3>
        {tierDiscount && (
          <ActiveDiscountChip
            discount={tierDiscount}
            label={`${TIER_LABELS[tier]} tier`}
            onRemove={() => onRemoveDiscount(tierDiscount.id)}
            onExpired={onChanged}
          />
        )}
      </div>

      {discounting && (
        <DiscountControl
          label={`Entire ${TIER_LABELS[tier]} tier`}
          mode={discountMode}
          onApply={(value) =>
            onProposeDiscount({ scope: 'tier', storageType: tier, mode: discountMode, value })}
          className="mb-2"
        />
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full min-w-150 text-sm border-collapse">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {(discounting
                ? ['Storage', 'Price', 'Current price', 'Discount', '']
                : ['Storage', 'Price', 'Current price', '']
              ).map((h, i) => (
                <th key={i} className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                discounts={discounts}
                discounting={discounting}
                discountMode={discountMode}
                onProposeDiscount={onProposeDiscount}
                onRemoveDiscount={onRemoveDiscount}
                onChanged={onChanged}
              />
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={discounting ? 5 : 4} className="px-4 py-6 text-center text-xs text-gray-400">
                  No line items on this tier yet — purchases fall back to the built-in plans until you add some.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add line item */}
      {adding ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <input
            type="number" min="1" placeholder="Quantity" value={addDraft.qty}
            onChange={(e) => setAddDraft({ ...addDraft, qty: e.target.value })}
            className="w-24 border border-gray-200 rounded-md px-2 py-1.5"
          />
          <select
            value={addDraft.unit}
            onChange={(e) => setAddDraft({ ...addDraft, unit: e.target.value as 'GB' | 'TB' })}
            className="border border-gray-200 rounded-md px-2 py-1.5 bg-white cursor-pointer"
          >
            <option>GB</option>
            <option>TB</option>
          </select>
          <span className="text-gray-400">for</span>
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400">$</span>
            <input
              type="number" min="0" step="0.01" placeholder="0.00" value={addDraft.price}
              onChange={(e) => setAddDraft({ ...addDraft, price: e.target.value })}
              className="w-28 border border-gray-200 rounded-md pl-5 pr-2 py-1.5"
            />
          </div>
          <button
            onClick={() => createMutation.mutate()}
            disabled={!addValid || createMutation.isPending}
            className="px-3 py-1.5 text-xs rounded-md bg-blue-600 text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {createMutation.isPending ? 'Adding…' : 'Add'}
          </button>
          <button
            onClick={() => setAdding(false)}
            className="px-3 py-1.5 text-xs rounded-md border border-gray-200 text-gray-600 cursor-pointer bg-white"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 cursor-pointer bg-transparent border-0"
        >
          <MdAdd /> Add line item
        </button>
      )}
    </div>
  )
}

// ── Item row ─────────────────────────────────────────────────────────────────

interface ItemRowProps {
  item: PricingItem
  discounts: PricingDiscount[]
  discounting: boolean
  discountMode: DiscountMode
  onProposeDiscount: (p: PendingDiscount) => void
  onRemoveDiscount: (id: string) => void
  onChanged: () => void
}

function ItemRow({
  item, discounts, discounting, discountMode, onProposeDiscount, onRemoveDiscount, onChanged,
}: ItemRowProps) {
  const { notify } = useNotification()
  const [draft, setDraft] = useState<QtyDraft>(() => draftFromItem(item))

  // Re-sync the editor when the server copy changes (e.g. after save).
  useEffect(() => {
    setDraft(draftFromItem(item))
  }, [item.bytes, item.price_cents]) // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = draftBytes(draft) !== item.bytes || draftCents(draft) !== item.price_cents
  const valid = draftBytes(draft) > 0 && draftCents(draft) >= 0

  const saveMutation = useMutation({
    mutationFn: () =>
      updatePricingItem(item.id, {
        bytes: draftBytes(draft),
        price_cents: draftCents(draft),
        sort_order: item.sort_order,
      }),
    onSuccess: () => {
      onChanged()
      notify('success', 'Line item updated')
    },
    onError: (e: Error) => notify('error', e.message || 'Failed to update line item'),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deletePricingItem(item.id),
    onSuccess: () => {
      onChanged()
      notify('success', 'Line item removed')
    },
    onError: () => notify('error', 'Failed to remove line item'),
  })

  const active = resolveDiscount(item, discounts)
  const itemDiscount = discounts.find((d) => d.scope === 'item' && d.item_id === item.id)

  return (
    <tr className="hover:bg-gray-50 transition-colors align-top">
      {/* Storage quantity editor */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <input
            type="number" min="1" value={draft.qty}
            onChange={(e) => setDraft({ ...draft, qty: e.target.value })}
            className="w-20 border border-gray-200 rounded-md px-2 py-1 text-sm"
          />
          <select
            value={draft.unit}
            onChange={(e) => setDraft({ ...draft, unit: e.target.value as 'GB' | 'TB' })}
            className="border border-gray-200 rounded-md px-1.5 py-1 text-sm bg-white cursor-pointer"
          >
            <option>GB</option>
            <option>TB</option>
          </select>
        </div>
      </td>

      {/* Base price editor */}
      <td className="px-4 py-3">
        <div className="relative inline-block">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
          <input
            type="number" min="0" step="0.01" value={draft.price}
            onChange={(e) => setDraft({ ...draft, price: e.target.value })}
            className="w-24 border border-gray-200 rounded-md pl-5 pr-2 py-1 text-sm"
          />
        </div>
      </td>

      {/* Current (effective) price */}
      <td className="px-4 py-3">
        {active ? (
          <div className="flex flex-col gap-0.5">
            <MarkedDownPrice
              originalLabel={formatCents(item.price_cents)}
              currentLabel={formatCents(discountedCents(active, item.price_cents))}
              percent={discountPercentFor(active, item.price_cents)}
            />
            <DiscountCountdown expiresAt={active.expires_at} onExpired={onChanged} />
          </div>
        ) : (
          <span className="text-gray-700">{formatCents(item.price_cents)}</span>
        )}
      </td>

      {/* Per-item discount control */}
      {discounting && (
        <td className="px-4 py-3">
          {itemDiscount ? (
            <button
              onClick={() => onRemoveDiscount(itemDiscount.id)}
              className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700 cursor-pointer bg-transparent border border-red-200 hover:border-red-400 rounded px-2 py-1"
            >
              <MdClose /> Remove discount
            </button>
          ) : (
            <DiscountControl
              compact
              label=""
              mode={discountMode}
              onApply={(value) =>
                onProposeDiscount({ scope: 'item', itemId: item.id, storageType: item.storage_type, mode: discountMode, value })}
            />
          )}
        </td>
      )}

      {/* Row actions */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {dirty && (
            <button
              onClick={() => saveMutation.mutate()}
              disabled={!valid || saveMutation.isPending}
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 cursor-pointer bg-transparent border border-blue-200 hover:border-blue-400 rounded px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <MdSave /> {saveMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          )}
          <button
            onClick={() => {
              if (confirm(`Remove the ${formatBytesLabel(item.bytes)} line item?`)) deleteMutation.mutate()
            }}
            disabled={deleteMutation.isPending}
            className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700 cursor-pointer bg-transparent border border-red-200 hover:border-red-400 rounded px-2 py-1 disabled:opacity-40"
          >
            <MdDelete /> Remove
          </button>
        </div>
      </td>
    </tr>
  )
}

// ── Discount input control (slider for %, input for reduced price) ───────────

function DiscountControl({
  label, mode, onApply, compact = false, className = '',
}: {
  label: string
  mode: DiscountMode
  onApply: (value: number) => void
  compact?: boolean
  className?: string
}) {
  const [percent, setPercent] = useState(10)
  const [price, setPrice] = useState('')

  const priceCents = Math.round(parseFloat(price || 'NaN') * 100)
  const valid = mode === 'percent' ? percent >= 1 && percent <= 99 : Number.isFinite(priceCents) && priceCents >= 0

  return (
    <div className={`${compact ? '' : 'bg-green-50 border border-green-200 rounded-lg px-3 py-2'} flex flex-wrap items-center gap-2 ${className}`}>
      {label && <span className="text-xs font-medium text-green-800">{label}</span>}
      {mode === 'percent' ? (
        <div className="flex items-center gap-2">
          <input
            type="range" min={1} max={99} value={percent}
            onChange={(e) => setPercent(Number(e.target.value))}
            className="w-32 accent-green-600 cursor-pointer"
          />
          <span className="text-xs font-semibold text-green-700 w-9 tabular-nums">−{percent}%</span>
        </div>
      ) : (
        <div className="relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">$</span>
          <input
            type="number" min="0" step="0.01" placeholder="Reduced price" value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="w-28 border border-green-300 rounded-md pl-5 pr-2 py-1 text-xs bg-white"
          />
        </div>
      )}
      <button
        onClick={() => onApply(mode === 'percent' ? percent : priceCents)}
        disabled={!valid}
        className="px-2.5 py-1 text-xs rounded-md bg-green-600 text-white cursor-pointer hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Discount…
      </button>
    </div>
  )
}

// ── Active discount chip (server / tier level) ───────────────────────────────

function ActiveDiscountChip({
  discount, label, onRemove, onExpired, className = '',
}: {
  discount: PricingDiscount
  label: string
  onRemove: () => void
  onExpired: () => void
  className?: string
}) {
  const valueLabel =
    discount.mode === 'percent'
      ? `−${discount.percent_off}%`
      : `now ${formatCents(discount.price_cents ?? 0)} per item`
  return (
    <div className={`inline-flex flex-wrap items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-1.5 text-xs ${className}`}>
      <MdLocalOffer className="text-green-600" />
      <span className="font-medium text-green-800">{label}: {valueLabel}</span>
      {discount.mode === 'percent' && <DiscountBadge percent={discount.percent_off ?? 0} />}
      {discount.premium_only && (
        <span className="px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 font-semibold">Premium only</span>
      )}
      <DiscountCountdown expiresAt={discount.expires_at} onExpired={onExpired} />
      <button
        onClick={onRemove}
        title="Remove discount"
        className="text-red-500 hover:text-red-700 cursor-pointer bg-transparent border-0 inline-flex items-center"
      >
        <MdClose />
      </button>
    </div>
  )
}

// ── Confirmation modal: expiry + notifications + premium gating ──────────────

function DiscountConfirmModal({
  pending, server, items, onClose, onCreated, onError,
}: {
  pending: PendingDiscount
  server: PricingServer
  items: PricingItem[]
  onClose: () => void
  onCreated: (notified: number) => void
  onError: (msg: string) => void
}) {
  const [expiry, setExpiry] = useState<Date | null>(null)
  const [notifyAll, setNotifyAll] = useState(false)
  const [notifyServer, setNotifyServer] = useState(false)
  const [notifyTier, setNotifyTier] = useState(false)
  const [premiumOnly, setPremiumOnly] = useState(false)

  // Containment: a broader group absorbs (checks + disables) the narrower
  // ones — all ⊃ server ⊃ server+tier.
  const serverChecked = notifyAll || notifyServer
  const tierChecked = notifyAll || notifyServer || notifyTier
  const notifyGroup: NotifyGroup | undefined = notifyAll
    ? 'all'
    : notifyServer
      ? 'server'
      : notifyTier
        ? 'server_tier'
        : undefined

  // The tier checkbox needs a single tier — hidden for server-wide discounts.
  const hasTier = pending.scope !== 'server'

  const affected = items.filter((it) => {
    if (pending.scope === 'item') return it.id === pending.itemId
    if (pending.scope === 'tier') return it.storage_type === pending.storageType
    return true
  })

  const fakeDiscount: PricingDiscount = {
    id: '', scope: pending.scope, server_id: server.id, storage_type: pending.storageType,
    item_id: pending.itemId, mode: pending.mode,
    percent_off: pending.mode === 'percent' ? pending.value : undefined,
    price_cents: pending.mode === 'price' ? pending.value : undefined,
    premium_only: premiumOnly, created_by: '', created_at: '',
  }

  const priceTooHigh =
    pending.scope === 'item' && pending.mode === 'price' &&
    affected.length > 0 && pending.value >= affected[0].price_cents

  const createMutation = useMutation({
    mutationFn: () => {
      const input: CreateDiscountInput = {
        scope: pending.scope,
        mode: pending.mode,
        premium_only: premiumOnly,
      }
      if (pending.scope === 'item') input.item_id = pending.itemId
      else {
        input.server_id = server.id
        if (pending.scope === 'tier') input.storage_type = pending.storageType
      }
      if (pending.mode === 'percent') input.percent_off = pending.value
      else input.price_cents = pending.value
      if (expiry) input.expires_at = expiry.toISOString()
      if (notifyGroup) input.notify = notifyGroup
      return createPricingDiscount(input)
    },
    onSuccess: (res) => onCreated(res.recipients_notified),
    onError: (e: Error) => onError(e.message || 'Failed to create discount'),
  })

  const scopeLabel =
    pending.scope === 'server'
      ? `every plan on ${server.name}`
      : pending.scope === 'tier'
        ? `every ${TIER_LABELS[pending.storageType!]} plan on ${server.name}`
        : affected[0]
          ? `the ${formatBytesLabel(affected[0].bytes)} ${TIER_LABELS[affected[0].storage_type]} plan on ${server.name}`
          : 'this plan'

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-gray-900 m-0 flex items-center gap-2">
            <MdLocalOffer className="text-green-600" /> Confirm discount
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0">
            <MdClose className="text-xl" />
          </button>
        </div>

        <p className="text-sm text-gray-600 mb-3">
          {pending.mode === 'percent'
            ? <>Applying <strong>−{pending.value}%</strong> to {scopeLabel}.</>
            : <>Reducing {scopeLabel} to <strong>{formatCents(pending.value)}</strong> (the % deduction is calculated per item).</>}
        </p>

        {priceTooHigh && (
          <p className="text-xs text-red-600 mb-3">
            The reduced price must be below the item&#39;s current price ({formatCents(affected[0].price_cents)}).
          </p>
        )}

        {/* Affected items preview */}
        <div className="border border-gray-100 rounded-lg divide-y divide-gray-100 mb-4 max-h-40 overflow-y-auto">
          {affected.map((it) => {
            const newCents = discountedCents(fakeDiscount, it.price_cents)
            const pct = discountPercentFor(fakeDiscount, it.price_cents)
            return (
              <div key={it.id} className="flex items-center justify-between px-3 py-1.5 text-xs">
                <span className="text-gray-700">{formatBytesLabel(it.bytes)} {TIER_LABELS[it.storage_type]}</span>
                {newCents < it.price_cents ? (
                  <MarkedDownPrice
                    originalLabel={formatCents(it.price_cents)}
                    currentLabel={formatCents(newCents)}
                    percent={pct}
                  />
                ) : (
                  <span className="text-gray-400">unchanged ({formatCents(it.price_cents)})</span>
                )}
              </div>
            )
          })}
          {affected.length === 0 && (
            <div className="px-3 py-2 text-xs text-gray-400">No line items in scope.</div>
          )}
        </div>

        {/* Expiry date picker */}
        <ExpiryPicker value={expiry} onChange={setExpiry} />

        {/* Notifications */}
        <div className="mb-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Email notifications</p>
          <label className="flex items-center gap-2 text-sm text-gray-700 py-0.5 cursor-pointer">
            <input
              type="checkbox" checked={notifyAll}
              onChange={(e) => setNotifyAll(e.target.checked)}
              className="accent-blue-600 cursor-pointer"
            />
            All users
          </label>
          <label className={`flex items-center gap-2 text-sm py-0.5 ${notifyAll ? 'text-gray-400' : 'text-gray-700 cursor-pointer'}`}>
            <input
              type="checkbox" checked={serverChecked} disabled={notifyAll}
              onChange={(e) => setNotifyServer(e.target.checked)}
              className="accent-blue-600 cursor-pointer disabled:cursor-not-allowed"
            />
            Users on this server ({server.name})
          </label>
          {hasTier && (
            <label className={`flex items-center gap-2 text-sm py-0.5 ${notifyAll || notifyServer ? 'text-gray-400' : 'text-gray-700 cursor-pointer'}`}>
              <input
                type="checkbox" checked={tierChecked} disabled={notifyAll || notifyServer}
                onChange={(e) => setNotifyTier(e.target.checked)}
                className="accent-blue-600 cursor-pointer disabled:cursor-not-allowed"
              />
              Users on this server &amp; {TIER_LABELS[pending.storageType!]} tier
            </label>
          )}
        </div>

        {/* Premium gating */}
        <label className="flex items-start gap-2 text-sm text-gray-700 mb-4 cursor-pointer">
          <input
            type="checkbox" checked={premiumOnly}
            onChange={(e) => setPremiumOnly(e.target.checked)}
            className="accent-purple-600 mt-0.5 cursor-pointer"
          />
          <span>
            Premium &amp; admin users only
            <span className="block text-xs text-gray-400">
              Non-premium users keep the regular price; notifications above go only to premium users and admins.
            </span>
          </span>
        </label>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md border border-gray-200 text-gray-600 cursor-pointer bg-white hover:border-gray-400"
          >
            Cancel
          </button>
          <button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || priceTooHigh || affected.length === 0}
            className="px-4 py-2 text-sm rounded-md bg-green-600 text-white cursor-pointer hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {createMutation.isPending ? 'Applying…' : 'Confirm discount'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Expiry date picker (dropdown button → calendar) ──────────────────────────

function ExpiryPicker({ value, onChange }: { value: Date | null; onChange: (d: Date | null) => void }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="mb-4 relative">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Expires</p>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-gray-200 bg-white text-gray-700 cursor-pointer hover:border-gray-400"
        >
          <MdEvent className="text-gray-400" />
          {value ? value.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : 'No expiry'}
        </button>
        {value && (
          <button
            onClick={() => onChange(null)}
            className="text-xs text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0"
          >
            Clear (never expires)
          </button>
        )}
      </div>
      {open && (
        <div className="absolute z-10 mt-1">
          <MiniCalendar
            selected={value}
            onSelect={(d) => {
              // The discount runs through the end of the picked day.
              const end = new Date(d)
              end.setHours(23, 59, 59, 999)
              onChange(end)
              setOpen(false)
            }}
          />
        </div>
      )}
    </div>
  )
}

function MiniCalendar({ selected, onSelect }: { selected: Date | null; onSelect: (d: Date) => void }) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const [month, setMonth] = useState(() => {
    const base = selected ?? today
    return new Date(base.getFullYear(), base.getMonth(), 1)
  })

  const firstDay = month.getDay() // 0 = Sunday
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells: (number | null)[] = [
    ...Array.from({ length: firstDay }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 w-64 select-none">
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          className="p-1 text-gray-500 hover:text-gray-800 cursor-pointer bg-transparent border-0"
        >
          <MdChevronLeft />
        </button>
        <span className="text-sm font-semibold text-gray-800">
          {month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </span>
        <button
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          className="p-1 text-gray-500 hover:text-gray-800 cursor-pointer bg-transparent border-0"
        >
          <MdChevronRight />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center text-[11px] text-gray-400 mb-1">
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => <span key={d}>{d}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((day, i) => {
          if (day === null) return <span key={`empty-${i}`} />
          const date = new Date(month.getFullYear(), month.getMonth(), day)
          const past = date < today
          const isSelected =
            !!selected &&
            selected.getFullYear() === date.getFullYear() &&
            selected.getMonth() === date.getMonth() &&
            selected.getDate() === date.getDate()
          return (
            <button
              key={day}
              disabled={past}
              onClick={() => onSelect(date)}
              className={`h-8 rounded-md text-xs cursor-pointer border-0 transition-colors ${
                isSelected
                  ? 'bg-green-600 text-white font-semibold'
                  : past
                    ? 'text-gray-300 cursor-not-allowed bg-transparent'
                    : 'text-gray-700 hover:bg-green-50 bg-transparent'
              }`}
            >
              {day}
            </button>
          )
        })}
      </div>
    </div>
  )
}
