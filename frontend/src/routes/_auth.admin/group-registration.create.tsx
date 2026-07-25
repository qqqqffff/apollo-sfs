import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { MdAdd, MdArrowBack, MdClose, MdEdit } from 'react-icons/md'
import {
  createRegistrationGroup,
  updateRegistrationGroup,
  getRegistrationGroup,
  registrationCapacityQueryOptions,
  type SlotAccountStatus,
  type SlotDriveType,
  type RegistrationSlotSpecInput,
  type RegistrationSlotType,
} from '../../api/registrationGroups'
import { formatSlotQuota, tierLabel } from '../../components/GroupRegistrationSection'
import { ApiError } from '../../api/client'
import { useNotification } from '../../context/NotificationContext'

interface GroupRegistrationCreateParams {
  // Present in edit mode: prefills the form with this group's data and
  // switches submit to PATCH the existing group instead of creating a new
  // one. Slots are immutable once created (see registrationGroups.ts) so the
  // slot builder is replaced with a read-only list in this mode.
  groupId?: string
}

export const Route = createFileRoute('/_auth/admin/group-registration/create')({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): GroupRegistrationCreateParams => ({
    groupId: typeof search.groupId === 'string' && search.groupId ? search.groupId : undefined,
  }),
})

const GB = 1024 ** 3
const QUICK_CAPACITIES_GB = [10, 50, 100, 250, 500]

// Default premium trial expiry offered when a slot is switched to premium.
function defaultPremiumExpiry(): string {
  return new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// One slot configuration being assembled in the builder.
interface DraftSlot {
  serverId: string
  serverName: string
  driveType: SlotDriveType
  quotaBytes: number
  accountStatus: SlotAccountStatus
  premiumExpiresAt: string // date string, '' = permanent premium (or base slot)
  count: number
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function RouteComponent() {
  const navigate = useNavigate()
  const { notify } = useNotification()
  const { groupId } = Route.useSearch()
  const isEditMode = !!groupId
  const { data: capacityData } = useQuery(registrationCapacityQueryOptions)

  const { data: existingGroup, isLoading: loadingGroup, error: loadGroupError } = useQuery({
    queryKey: ['admin', 'registration-groups', groupId],
    queryFn: () => getRegistrationGroup(groupId!),
    enabled: isEditMode,
    retry: false,
  })

  // Group-level fields
  const [name, setName] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [notifyEmails, setNotifyEmails] = useState<string[]>([])
  const [emailInput, setEmailInput] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [sendReminder, setSendReminder] = useState(false)

  // Slot builder fields
  const [slots, setSlots] = useState<DraftSlot[]>([])
  const [selectedServerId, setSelectedServerId] = useState('')
  const [selectedTier, setSelectedTier] = useState<SlotDriveType | ''>('')
  const [capacityGb, setCapacityGb] = useState('10')
  const [accountStatus, setAccountStatus] = useState<SlotAccountStatus>('base')
  const [premiumExpiry, setPremiumExpiry] = useState('')
  const [slotCount, setSlotCount] = useState('1')
  const [createError, setCreateError] = useState<string | null>(null)

  // Seed the group-level fields from the existing group exactly once, so
  // subsequent refetches (e.g. the 30s capacity poll elsewhere) don't stomp
  // on in-progress edits.
  const seededRef = useRef(false)
  useEffect(() => {
    if (!isEditMode || !existingGroup || seededRef.current) return
    seededRef.current = true
    setName(existingGroup.name)
    setExpiresAt(existingGroup.expires_at ? existingGroup.expires_at.slice(0, 10) : '')
    setNotifyEmails(existingGroup.notify_emails)
    setSendReminder(existingGroup.send_expiry_reminder)
  }, [isEditMode, existingGroup])

  // Servers and their tiers, from the capacity endpoint (already net of user
  // allocations and other groups' slot reservations).
  const servers = useMemo(() => {
    const map = new Map<string, { id: string; name: string; tiers: Partial<Record<SlotDriveType, number>> }>()
    for (const t of capacityData?.tiers ?? []) {
      if (!map.has(t.server_id)) map.set(t.server_id, { id: t.server_id, name: t.server_name, tiers: {} })
      map.get(t.server_id)!.tiers[t.drive_type] = t.available_bytes
    }
    return Array.from(map.values())
  }, [capacityData])

  const selectedServer = servers.find(s => s.id === selectedServerId)

  // Bytes the already-added draft slots would reserve, per server+tier — shown
  // live so the admin sees each slot reducing the space left on the server.
  const pendingByTier = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of slots) {
      const key = `${s.serverId}:${s.driveType}`
      m.set(key, (m.get(key) ?? 0) + s.quotaBytes * s.count)
    }
    return m
  }, [slots])

  function remainingBytes(serverId: string, tier: SlotDriveType): number | null {
    const server = servers.find(s => s.id === serverId)
    const avail = server?.tiers[tier]
    if (avail === undefined) return null
    return avail - (pendingByTier.get(`${serverId}:${tier}`) ?? 0)
  }

  const draftQuotaBytes = Math.round((parseFloat(capacityGb) || 0) * GB)
  const draftCount = Math.max(1, Math.floor(Number(slotCount) || 1))
  const selectedRemaining = selectedServerId && selectedTier ? remainingBytes(selectedServerId, selectedTier) : null
  const draftExceedsCapacity = selectedRemaining !== null && draftQuotaBytes * draftCount > selectedRemaining

  const canAddSlot =
    !!selectedServer && !!selectedTier && draftQuotaBytes > 0 && draftCount >= 1 && !draftExceedsCapacity

  function addSlot() {
    if (!canAddSlot || !selectedServer || !selectedTier) return
    setSlots(prev => {
      // Identical configurations merge into one row with a higher count.
      const idx = prev.findIndex(s =>
        s.serverId === selectedServer.id && s.driveType === selectedTier &&
        s.quotaBytes === draftQuotaBytes && s.accountStatus === accountStatus &&
        s.premiumExpiresAt === (accountStatus === 'premium' ? premiumExpiry : ''))
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { ...next[idx], count: next[idx].count + draftCount }
        return next
      }
      return [...prev, {
        serverId: selectedServer.id,
        serverName: selectedServer.name,
        driveType: selectedTier,
        quotaBytes: draftQuotaBytes,
        accountStatus,
        premiumExpiresAt: accountStatus === 'premium' ? premiumExpiry : '',
        count: draftCount,
      }]
    })
  }

  // Loads an already-added draft slot's values back into the builder fields
  // for tweaking, removing it from the list — re-adding (with whatever
  // changed) replaces it. Only applies to slots in this session's draft list;
  // slots already submitted to an existing group are fixed (see the
  // read-only list in edit mode).
  function startEditSlot(index: number) {
    const s = slots[index]
    setSelectedServerId(s.serverId)
    setSelectedTier(s.driveType)
    setCapacityGb(String(s.quotaBytes / GB))
    setAccountStatus(s.accountStatus)
    setPremiumExpiry(s.premiumExpiresAt)
    setSlotCount(String(s.count))
    setSlots(prev => prev.filter((_, j) => j !== index))
  }

  function addEmail() {
    const email = emailInput.trim()
    if (!email) return
    if (!EMAIL_RE.test(email)) {
      setEmailError('Enter a valid email address')
      return
    }
    setEmailError(null)
    if (!notifyEmails.some(e => e.toLowerCase() === email.toLowerCase())) {
      setNotifyEmails(prev => [...prev, email])
    }
    setEmailInput('')
  }

  const createMutation = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
        notify_emails: notifyEmails,
        send_expiry_reminder: sendReminder && !!expiresAt,
        slots: slots.map((s): RegistrationSlotSpecInput => ({
          server_id: s.serverId,
          drive_type: s.driveType,
          quota_bytes: s.quotaBytes,
          account_status: s.accountStatus,
          ...(s.accountStatus === 'premium' && s.premiumExpiresAt
            ? { premium_expires_at: new Date(s.premiumExpiresAt).toISOString() }
            : {}),
          count: s.count,
        })),
      }
      return createRegistrationGroup(body)
    },
    onSuccess: () => {
      notify('success', 'Registration group created')
      navigate({ to: '/admin/requests', search: { tab: 'groups' } })
    },
    onError: (err) => {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to create the registration group')
    },
  })

  const updateMutation = useMutation({
    mutationFn: () => updateRegistrationGroup(groupId!, {
      name: name.trim(),
      ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
      notify_emails: notifyEmails,
      send_expiry_reminder: sendReminder && !!expiresAt,
    }),
    onSuccess: () => {
      notify('success', 'Registration group updated')
      navigate({ to: '/admin/requests', search: { tab: 'groups' } })
    },
    onError: (err) => {
      setCreateError(err instanceof ApiError ? err.message : 'Failed to update the registration group')
    },
  })

  const saving = createMutation.isPending || updateMutation.isPending
  const canCreate = name.trim().length > 0 && !saving && (isEditMode || slots.length > 0)

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link
          to="/admin/requests"
          search={{ tab: 'groups' }}
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 no-underline transition-colors"
        >
          <MdArrowBack /> Back
        </Link>
        <h2 className="text-lg font-semibold text-gray-900 m-0">
          {isEditMode ? 'Edit registration group' : 'New registration group'}
        </h2>
      </div>

      {isEditMode && loadingGroup && <p className="text-sm text-gray-500">Loading group…</p>}
      {isEditMode && loadGroupError && (
        <p className="text-sm text-red-500">
          {loadGroupError instanceof ApiError ? loadGroupError.message : 'Failed to load the registration group.'}
        </p>
      )}

      {(!isEditMode || existingGroup) && (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setCreateError(null)
          if (isEditMode) updateMutation.mutate()
          else createMutation.mutate()
        }}
        className="flex flex-col gap-6 max-w-3xl"
      >
        {/* Group settings */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-4">
          <h3 className="text-sm font-semibold text-gray-900 m-0">Group</h3>
          <label className="flex flex-col gap-1 max-w-sm">
            <span className="text-xs font-medium text-gray-600">Name <span className="text-red-500">*</span></span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              placeholder="e.g. Robotics Club"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <span className="text-xs text-gray-400">
              The link becomes {window.location.origin}/group-invite?id={(name.trim() || 'group-name').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group-name'}-xxxx
            </span>
          </label>
          <label className="flex flex-col gap-1 max-w-sm">
            <span className="text-xs font-medium text-gray-600">Registration expires</span>
            <input
              type="date"
              value={expiresAt}
              min={new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 w-fit"
            />
            <span className="text-xs text-gray-400">(blank = the link never expires)</span>
          </label>
        </div>

        {/* Slot builder */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-4">
          <h3 className="text-sm font-semibold text-gray-900 m-0">Registration slots</h3>

          {isEditMode ? (
            <>
              {existingGroup && existingGroup.slot_types.length > 0 && (
                <div className="rounded-lg border border-gray-200 overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        {['Server', 'Tier', 'Capacity', 'Account status', 'Count'].map((h) => (
                          <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {existingGroup.slot_types.map((t: RegistrationSlotType) => (
                        <tr key={t.slot_id}>
                          <td className="px-3 py-2 text-gray-800">{t.server_name}</td>
                          <td className="px-3 py-2">
                            <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              t.drive_type === 'nvme' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
                            }`}>
                              {tierLabel(t.drive_type)}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{formatSlotQuota(t.quota_bytes)}</td>
                          <td className="px-3 py-2 text-gray-600">
                            {t.account_status === 'premium'
                              ? `Premium${t.premium_expires_at ? ` (expires ${new Date(t.premium_expires_at).toLocaleDateString()})` : ' (permanent)'}`
                              : 'Base user'}
                          </td>
                          <td className="px-3 py-2 text-gray-800 font-medium">{t.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-xs text-gray-400 m-0">
                Slots are fixed once a group is created — deactivate or delete the group to change its capacity.
              </p>
            </>
          ) : (
          <>
          {slots.length > 0 && (
            <div className="rounded-lg border border-gray-200 overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    {['Server', 'Tier', 'Capacity', 'Account status', 'Count', ''].map((h) => (
                      <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {slots.map((s, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2 text-gray-800">{s.serverName}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          s.driveType === 'nvme' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
                        }`}>
                          {tierLabel(s.driveType)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{formatSlotQuota(s.quotaBytes)}</td>
                      <td className="px-3 py-2 text-gray-600">
                        {s.accountStatus === 'premium'
                          ? `Premium${s.premiumExpiresAt ? ` (expires ${new Date(s.premiumExpiresAt).toLocaleDateString()})` : ' (permanent)'}`
                          : 'Base user'}
                      </td>
                      <td className="px-3 py-2 text-gray-800 font-medium">{s.count}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center gap-1 justify-end">
                          <button
                            type="button"
                            onClick={() => startEditSlot(i)}
                            title="Edit slot"
                            className="text-gray-400 hover:text-blue-600 cursor-pointer bg-transparent border-0 p-0.5"
                          >
                            <MdEdit />
                          </button>
                          <button
                            type="button"
                            onClick={() => setSlots(prev => prev.filter((_, j) => j !== i))}
                            title="Remove slot"
                            className="text-gray-400 hover:text-red-500 cursor-pointer bg-transparent border-0 p-0.5"
                          >
                            <MdClose />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-col gap-3 rounded-lg border border-dashed border-gray-300 p-4">
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-600">Server</span>
                <select
                  value={selectedServerId}
                  onChange={(e) => {
                    setSelectedServerId(e.target.value)
                    setSelectedTier('')
                  }}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-40"
                >
                  <option value="">Select a server…</option>
                  {servers.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>

              {selectedServer && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-600">Tier</span>
                  <div className="flex gap-2">
                    {(['nvme', 'hdd'] as SlotDriveType[]).map(tier => {
                      // Only tiers the selected server actually has are offered.
                      if (selectedServer.tiers[tier] === undefined) return null
                      const remaining = remainingBytes(selectedServer.id, tier)
                      return (
                        <button
                          key={tier}
                          type="button"
                          onClick={() => setSelectedTier(tier)}
                          className={`flex flex-col items-start px-3 py-1.5 rounded-md border text-xs cursor-pointer transition-colors ${
                            selectedTier === tier
                              ? 'bg-blue-50 border-blue-400 text-blue-700'
                              : 'bg-white border-gray-200 text-gray-700 hover:border-gray-400'
                          }`}
                        >
                          <span className="font-medium">{tier === 'nvme' ? 'Fast' : 'Standard'}</span>
                          <span className="text-[10px] text-gray-400">
                            {remaining !== null ? `${formatSlotQuota(Math.max(0, remaining))} left` : ''}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-600">Capacity</span>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={capacityGb}
                    onChange={(e) => setCapacityGb(e.target.value)}
                    className="w-24 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-xs text-gray-400">GB</span>
                </div>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-600">Count</span>
                <input
                  type="number"
                  min="1"
                  max="500"
                  step="1"
                  value={slotCount}
                  onChange={(e) => setSlotCount(e.target.value)}
                  className="w-20 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </label>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-500">Quick capacity:</span>
              {QUICK_CAPACITIES_GB.map(gb => (
                <button
                  key={gb}
                  type="button"
                  onClick={() => setCapacityGb(String(gb))}
                  className={`px-2 py-0.5 text-xs rounded-md border cursor-pointer transition-colors ${
                    parseFloat(capacityGb) === gb
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                  }`}
                >
                  {gb} GB
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-600">Account status</span>
                <div className="flex gap-2">
                  {(['base', 'premium'] as SlotAccountStatus[]).map(status => (
                    <button
                      key={status}
                      type="button"
                      onClick={() => {
                        setAccountStatus(status)
                        // Premium defaults to a 14-day trial; clearing the date
                        // makes the grant permanent.
                        setPremiumExpiry(status === 'premium' ? defaultPremiumExpiry() : '')
                      }}
                      className={`px-3 py-1.5 rounded-md border text-xs cursor-pointer transition-colors ${
                        accountStatus === status
                          ? status === 'premium'
                            ? 'bg-amber-50 border-amber-400 text-amber-700'
                            : 'bg-blue-50 border-blue-400 text-blue-700'
                          : 'bg-white border-gray-200 text-gray-700 hover:border-gray-400'
                      }`}
                    >
                      {status === 'premium' ? 'Premium' : 'Base user'}
                    </button>
                  ))}
                </div>
              </div>
              {accountStatus === 'premium' && (
                <label className="flex items-center gap-2 select-none">
                  <span className="text-xs text-gray-500">Premium expires</span>
                  <input
                    type="date"
                    value={premiumExpiry}
                    onChange={(e) => setPremiumExpiry(e.target.value)}
                    min={new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}
                    className="border border-gray-200 rounded-lg px-2 py-1 text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-xs text-gray-400">(blank = permanent)</span>
                </label>
              )}
            </div>

            {draftExceedsCapacity && (
              <p className="text-xs text-red-500 m-0">
                These slots exceed the remaining {selectedTier === 'nvme' ? 'fast' : 'standard'}-tier capacity on {selectedServer?.name}.
              </p>
            )}

            <button
              type="button"
              onClick={addSlot}
              disabled={!canAddSlot}
              className="self-start inline-flex items-center gap-1 px-3 py-1.5 text-sm bg-white border border-gray-300 hover:border-blue-400 hover:text-blue-700 text-gray-700 rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <MdAdd /> Add slot{draftCount > 1 ? `s (${draftCount})` : ''}
            </button>
          </div>
          <p className="text-xs text-gray-400 m-0">
            Each slot pre-reserves its capacity on the server until it is claimed, the group is
            deactivated, or the link expires. Admin accounts cannot be provisioned via group registration.
          </p>
          </>
          )}
        </div>

        {/* Notifications */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-4">
          <h3 className="text-sm font-semibold text-gray-900 m-0">Email notifications</h3>
          <div className="flex flex-col gap-2 max-w-sm">
            <span className="text-xs font-medium text-gray-600">Notify these addresses about the invite</span>
            <div className="flex gap-2">
              <input
                type="email"
                value={emailInput}
                onChange={(e) => { setEmailInput(e.target.value); setEmailError(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addEmail() } }}
                placeholder="person@example.com"
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={addEmail}
                className="px-3 py-1.5 text-sm bg-white border border-gray-300 hover:border-blue-400 hover:text-blue-700 text-gray-700 rounded-lg cursor-pointer transition-colors"
              >
                Add
              </button>
            </div>
            {emailError && <p className="text-xs text-red-500 m-0">{emailError}</p>}
            {notifyEmails.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {notifyEmails.map(email => (
                  <span key={email} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-xs text-gray-700">
                    {email}
                    <button
                      type="button"
                      onClick={() => setNotifyEmails(prev => prev.filter(e => e !== email))}
                      className="text-gray-400 hover:text-red-500 cursor-pointer bg-transparent border-0 p-0"
                      title="Remove"
                    >
                      <MdClose className="text-xs" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <span className="text-xs text-gray-400">
              Recipients get the invite link, the number of available slots{expiresAt ? ', and the expiry date' : ''}.
            </span>
          </div>
          <label className={`flex items-center gap-2 select-none w-fit ${expiresAt ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}>
            <input
              type="checkbox"
              checked={sendReminder && !!expiresAt}
              disabled={!expiresAt}
              onChange={(e) => setSendReminder(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 accent-blue-600 cursor-pointer"
            />
            <span className="text-xs text-gray-600">
              Send a “last chance” follow-up 1 day before expiry with the updated slot count
              {!expiresAt ? ' (requires an expiry date)' : ''}
            </span>
          </label>
        </div>

        {createError && <p className="text-sm text-red-500 m-0">{createError}</p>}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!canCreate}
            className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg disabled:opacity-50 cursor-pointer transition-colors"
          >
            {isEditMode
              ? (updateMutation.isPending ? 'Saving…' : 'Save changes')
              : (createMutation.isPending ? 'Creating…' : 'Create registration group')}
          </button>
          {!isEditMode && slots.length === 0 && (
            <span className="text-xs text-gray-400">Add at least one slot to create the group.</span>
          )}
        </div>
      </form>
      )}
    </div>
  )
}
