import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  MdNotificationsNone,
  MdCloudDone,
  MdPayment,
  MdPendingActions,
  MdFolderShared,
} from 'react-icons/md'
import { listNotifications, type AppNotification, type NotificationKind } from '../api/billing'

const KIND_META: Record<NotificationKind, { icon: React.ComponentType<{ className?: string }>; className: string }> = {
  capacity_provisioned: { icon: MdCloudDone,       className: 'bg-green-50 text-green-600' },
  payment_required:     { icon: MdPayment,         className: 'bg-red-50 text-red-500' },
  action_pending:       { icon: MdPendingActions,  className: 'bg-amber-50 text-amber-600' },
  share_received:       { icon: MdFolderShared,    className: 'bg-blue-50 text-blue-600' },
}

// NotificationBell shows a badge with the user's pending-action notifications
// (capacity provisioned, payment required, invoice review pending, shares
// received) and a dropdown that deep-links each item.
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
              {items.map((n) => {
                const meta = KIND_META[n.kind] ?? KIND_META.action_pending
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
          )}
        </div>
      )}
    </div>
  )
}
