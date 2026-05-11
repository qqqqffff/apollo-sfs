import { createContext, useCallback, useContext, useRef, useState } from 'react'

export type NotificationType = 'success' | 'error'

export interface Notification {
  id: string
  type: NotificationType
  message: string
}

interface NotificationContextValue {
  notifications: Notification[]
  notify: (type: NotificationType, message: string) => void
  dismiss: (id: string) => void
}

const NotificationContext = createContext<NotificationContextValue | null>(null)

const AUTO_DISMISS_MS = 5000
const MAX_VISIBLE = 4

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    setNotifications((prev) => prev.filter((n) => n.id !== id))
  }, [])

  const notify = useCallback(
    (type: NotificationType, message: string) => {
      const id = crypto.randomUUID()
      setNotifications((prev) => [{ id, type, message }, ...prev].slice(0, MAX_VISIBLE))
      const timer = setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
      timers.current.set(id, timer)
    },
    [dismiss],
  )

  return (
    <NotificationContext.Provider value={{ notifications, notify, dismiss }}>
      {children}
    </NotificationContext.Provider>
  )
}

export function useNotification(): NotificationContextValue {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotification must be used within NotificationProvider')
  return ctx
}
