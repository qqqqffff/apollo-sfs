import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MdNotificationsNone,
  MdCloudDone,
  MdPayment,
  MdPendingActions,
  MdFolderShared,
  MdHistory,
  MdMarkEmailRead,
  MdMarkEmailUnread,
  MdNotificationImportant,
  MdPersonAddAlt1,
  MdReceiptLong,
  MdMoneyOff,
  MdStorage,
  MdExpandMore,
  MdChevronRight,
  MdClose,
} from 'react-icons/md'
import {
  listNotifications,
  dismissNotifications,
  dismissNotificationCategory,
  type AppNotification,
  type NotificationKind,
} from '../api/billing'
import { AllocationChangeBreakdown } from './AllocationChangeBreakdown'

interface KindMeta {
  icon: React.ComponentType<{ className?: string }>
  className: string
  // Category header the kind is grouped under in the dropdown.
  category: string
}

// Kinds are grouped into labelled categories: storage/billing/shares for every
// user, plus the admin-only activity kinds (invitation accepted, order
// received, email received, alarm triggered).
const KIND_META: Record<NotificationKind, KindMeta> = {
  capacity_provisioned: { icon: MdCloudDone,             className: 'bg-green-50 text-green-600',   category: 'Storage' },
  payment_required:     { icon: MdPayment,               className: 'bg-red-50 text-red-500',       category: 'Billing' },
  action_pending:       { icon: MdPendingActions,        className: 'bg-amber-50 text-amber-600',   category: 'Billing' },
  share_received:       { icon: MdFolderShared,          className: 'bg-blue-50 text-blue-600',     category: 'Shares' },
  subscription_cancelled: { icon: MdMoneyOff,             className: 'bg-orange-50 text-orange-600', category: 'Billing' },
  quota_changed:        { icon: MdStorage,               className: 'bg-sky-50 text-sky-600',       category: 'Storage' },
  email_backup_completed: { icon: MdMarkEmailRead,        className: 'bg-teal-50 text-teal-600',     category: 'Backups' },
  backup_stale:         { icon: MdHistory,               className: 'bg-amber-50 text-amber-600',   category: 'Backups' },
  invitation_accepted:  { icon: MdPersonAddAlt1,         className: 'bg-green-50 text-green-600',   category: 'Invitations' },
  order_received:       { icon: MdReceiptLong,           className: 'bg-blue-50 text-blue-600',     category: 'Orders' },
  email_received:       { icon: MdMarkEmailUnread,       className: 'bg-sky-50 text-sky-600',       category: 'Emails' },
  alarm_triggered:      { icon: MdNotificationImportant, className: 'bg-red-50 text-red-600',       category: 'Alarms' },
}

const FALLBACK_META: KindMeta = KIND_META.action_pending

// Category display order: actionable user notifications first, then admin
// activity, most urgent (alarms) at the top of the admin block.
const CATEGORY_ORDER = ['Billing', 'Storage', 'Shares', 'Backups', 'Alarms', 'Orders', 'Invitations', 'Emails']

// Categories collapsed by default when the dropdown first loads — Emails in
// particular can get noisy (one entry per inbound message), so it's tucked
// away behind a click rather than shown expanded like the actionable
// categories (billing, storage, shares).
const DEFAULT_COLLAPSED = new Set(['Emails'])

// NotificationBell shows a badge with the user's pending-action notifications
// (capacity provisioned, payment required, invoice review pending, shares
// received) — plus, for admins, recent activity alerts (invitations accepted,
// orders received, inbound emails, fired alarms) — grouped by collapsible
// categories, with each item deep-linking to the page it concerns. Items and
// whole categories can be dismissed, which persists server-side.
export function NotificationBell() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(DEFAULT_COLLAPSED)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const ref = useRef<HTMLDivElement>(null)

  function toggleBreakdown(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const { data: notifications = [] } = useQuery({
    queryKey: ['me', 'notifications'],
    queryFn: listNotifications,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const items = Array.isArray(notifications) ? notifications : []

  const dismissMutation = useMutation({
    mutationFn: (ids: string[]) => dismissNotifications(ids),
    onMutate: async (ids: string[]) => {
      await queryClient.cancelQueries({ queryKey: ['me', 'notifications'] })
      const previous = queryClient.getQueryData<AppNotification[]>(['me', 'notifications'])
      queryClient.setQueryData<AppNotification[]>(['me', 'notifications'], (prev) =>
        (prev ?? []).filter((n) => !ids.includes(n.id)),
      )
      return { previous }
    },
    onError: (_err, _ids, context) => {
      if (context?.previous) queryClient.setQueryData(['me', 'notifications'], context.previous)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['me', 'notifications'] })
    },
  })

  const dismissCategoryMutation = useMutation({
    mutationFn: (category: string) => dismissNotificationCategory(category),
    onMutate: async (category: string) => {
      await queryClient.cancelQueries({ queryKey: ['me', 'notifications'] })
      const previous = queryClient.getQueryData<AppNotification[]>(['me', 'notifications'])
      queryClient.setQueryData<AppNotification[]>(['me', 'notifications'], (prev) =>
        (prev ?? []).filter((n) => (KIND_META[n.kind] ?? FALLBACK_META).category !== category),
      )
      return { previous }
    },
    onError: (_err, _category, context) => {
      if (context?.previous) queryClient.setQueryData(['me', 'notifications'], context.previous)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['me', 'notifications'] })
    },
  })

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  function openItem(n: AppNotification) {
    setOpen(false)
    const [pathname, search] = n.link.split('?')
    const params = Object.fromEntries(new URLSearchParams(search ?? ''))
    navigate({ to: pathname as never, search: params as never })
  }

  function toggleCategory(category: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  // Group by category, preserving the server's newest-first order within each.
  const groups = new Map<string, AppNotification[]>()
  for (const n of items) {
    const category = (KIND_META[n.kind] ?? FALLBACK_META).category
    const list = groups.get(category) ?? []
    list.push(n)
    groups.set(category, list)
  }
  const orderedCategories = [
    ...CATEGORY_ORDER.filter((c) => groups.has(c)),
    ...[...groups.keys()].filter((c) => !CATEGORY_ORDER.includes(c)),
  ]

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        className="relative flex items-center justify-center w-8 h-8 rounded-full text-gray-500 hover:text-gray-800 hover:bg-gray-100 cursor-pointer bg-transparent border-0 transition-colors"
      >
        <MdNotificationsNone className="text-xl" />
        {items.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
            {items.length > 9 ? '9+' : items.length}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-x-4 top-14 sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-1 w-auto sm:w-80 max-w-full sm:max-w-[90vw] bg-white border border-gray-200 rounded-xl shadow-lg py-1 z-50">
          <p className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider m-0 border-b border-gray-100">
            Notifications
          </p>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-400 text-center m-0">You're all caught up.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              {orderedCategories.map((category) => {
                const categoryItems = groups.get(category)!
                const isCollapsed = collapsed.has(category)
                return (
                  <div key={category}>
                    <div className="flex items-center justify-between gap-2 pl-2 pr-4 pt-2.5 pb-1 bg-gray-50/60">
                      <button
                        onClick={() => toggleCategory(category)}
                        className="flex items-center gap-0.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-transparent border-0 p-0 pl-2 cursor-pointer hover:text-gray-600"
                      >
                        {isCollapsed ? <MdChevronRight className="text-sm" /> : <MdExpandMore className="text-sm" />}
                        {category} ({categoryItems.length})
                      </button>
                      <button
                        onClick={() => dismissCategoryMutation.mutate(category)}
                        className="text-[10px] font-medium text-gray-400 hover:text-gray-600 bg-transparent border-0 p-0 cursor-pointer"
                      >
                        Dismiss all
                      </button>
                    </div>
                    {!isCollapsed &&
                      categoryItems.map((n) => {
                        const meta = KIND_META[n.kind] ?? FALLBACK_META
                        const Icon = meta.icon
                        return (
                          <div key={n.id} className="group hover:bg-gray-50 transition-colors">
                            <div className="flex items-stretch">
                              <button
                                onClick={() => openItem(n)}
                                className="flex items-start gap-3 flex-1 min-w-0 pl-4 pr-1 py-2.5 text-left bg-transparent border-0 cursor-pointer"
                              >
                                <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${meta.className}`}>
                                  <Icon className="text-sm" />
                                </span>
                                <span className="min-w-0">
                                  <span className="block text-sm font-medium text-gray-800">{n.title}</span>
                                  <span className="block text-xs text-gray-500 mt-0.5">{n.body}</span>
                                  <span className="block text-[10px] text-gray-300 mt-0.5">
                                    {new Date(n.created_at).toLocaleDateString()}
                                  </span>
                                </span>
                              </button>
                              <button
                                onClick={() => dismissMutation.mutate([n.id])}
                                title="Dismiss"
                                className="shrink-0 flex items-center justify-center w-8 mr-1 text-gray-300 opacity-0 group-hover:opacity-100 hover:text-gray-600 bg-transparent border-0 cursor-pointer transition-opacity"
                              >
                                <MdClose className="text-base" />
                              </button>
                            </div>
                            {n.details && (
                              <div className="pl-14 pr-4 pb-2 -mt-1">
                                <button
                                  onClick={() => toggleBreakdown(n.id)}
                                  className="text-[10px] font-medium text-blue-500 hover:text-blue-700 bg-transparent border-0 p-0 cursor-pointer"
                                >
                                  {expandedIds.has(n.id) ? 'Hide breakdown' : 'Show breakdown'}
                                </button>
                                {expandedIds.has(n.id) && <AllocationChangeBreakdown details={n.details} />}
                              </div>
                            )}
                          </div>
                        )
                      })}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
