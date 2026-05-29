import { MdCheckCircle, MdClose, MdError } from 'react-icons/md'
import { useNotification } from '../context/NotificationContext'

export function NotificationBanner() {
  const { notifications, dismiss } = useNotification()

  if (notifications.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 w-full max-w-sm pointer-events-none">
      {notifications.map((n) => (
        <div
          key={n.id}
          className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl border shadow-lg text-sm ${
            n.type === 'success'
              ? 'bg-green-50 text-green-900 border-green-200'
              : 'bg-red-50 text-red-900 border-red-200'
          }`}
        >
          <span className="shrink-0 mt-0.5">
            {n.type === 'success'
              ? <MdCheckCircle className="text-green-500 text-base" />
              : <MdError className="text-red-500 text-base" />
            }
          </span>
          <span className="flex-1 leading-snug">{n.message}</span>
          <button
            onClick={() => dismiss(n.id)}
            aria-label="Dismiss"
            className="shrink-0 mt-0.5 opacity-40 hover:opacity-80 cursor-pointer bg-transparent border-0 text-current leading-none transition-opacity p-0"
          >
            <MdClose className="text-base" />
          </button>
        </div>
      ))}
    </div>
  )
}
