import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  MdNotificationsNone,
  MdCloudDone,
  MdPayment,
  MdPendingActions,
  MdFolderShared,
  MdMarkEmailUnread,
  MdNotificationImportant,
  MdPersonAddAlt1,
  MdReceiptLong,
} from 'react-icons/md'
import { listNotifications, type AppNotification, type NotificationKind } from '../api/billing'

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
  invitation_accepted:  { icon: MdPersonAddAlt1,         className: 'bg-green-50 text-green-600',   category: 'Invitations' },
  order_received:       { icon: MdReceiptLong,           className: 'bg-blue-50 text-blue-600',     category: 'Orders' },
  email_received:       { icon: MdMarkEmailUnread,       className: 'bg-sky-50 text-sky-600',       category: 'Emails' },
  alarm_triggered:      { icon: MdNotificationImportant, className: 'bg-red-50 text-red-600',       category: 'Alarms' },
}

const FALLBACK_META: KindMeta = KIND_META.action_pending

// Category display order: actionable user notifications first, then admin
// activity, most urgent (alarms) at the top of the admin block.
const CATEGORY_ORDER = ['Billing', 'Storage', 'Shares', 'Alarms', 'Orders', 'Invitations', 'Emails']

// NotificationBell shows a badge with the user's pending-action notifications
// (capacity provisioned, payment required, invoice review pending, shares
// received) — plus, for admins, recent activity alerts (invitations accepted,
// orders received, inbound emails, fired alarms) — grouped by category, with
// each item deep-linking to the page it concerns.
export function NotificationBell() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const { data: notifications = [] } = useQuery({
    queryKey: ['me', 'notifications'],
    queryFn: listNotifications,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const items = Array.isArray(notifications) ? notifications : []

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
        <div className="absolute right-0 top-full mt-1 w-80 max-w-[90vw] bg-white border border-gray-200 rounded-xl shadow-lg py-1 z-50">
          <p className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider m-0 border-b border-gray-100">
            Notifications
          </p>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-400 text-center m-0">You're all caught up.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              {orderedCategories.map((category) => (
                <div key={category}>
                  <p className="px-4 pt-2.5 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider m-0 bg-gray-50/60">
                    {category}
                  </p>
                  {groups.get(category)!.map((n) => {
                    const meta = KIND_META[n.kind] ?? FALLBACK_META
                    const Icon = meta.icon
                    return (
                      <button
                        key={n.id}
                        onClick={() => openItem(n)}
                        className="flex items-start gap-3 w-full px-4 py-2.5 text-left bg-transparent border-0 hover:bg-gray-50 cursor-pointer transition-colors"
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
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
