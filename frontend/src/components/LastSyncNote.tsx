import { useQuery } from '@tanstack/react-query'
import { MdHistory } from 'react-icons/md'
import { lastBackupSyncQueryOptions } from '../api/me'

// formatTimeSince renders a compact human "time since" string ("3 hours ago",
// "12 days ago") for the last-sync notes on the backup dialogs.
export function formatTimeSince(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (seconds < 60) return 'moments ago'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`
  const days = Math.floor(hours / 24)
  if (days < 60) return `${days} day${days !== 1 ? 's' : ''} ago`
  const months = Math.floor(days / 30)
  return `${months} month${months !== 1 ? 's' : ''} ago`
}

// LastSyncNote shows how long ago the given backup type last completed a sync
// ("Last backup completed 12 days ago"). Rendered on the Google backup and
// email backup start dialogs.
export function LastSyncNote({ kind }: { kind: 'google' | 'email' }) {
  const { data } = useQuery(lastBackupSyncQueryOptions)
  if (!data) return null

  const last = kind === 'google' ? data.google_last_sync : data.email_last_sync
  const stale = last !== null && Date.now() - new Date(last).getTime() > 30 * 24 * 60 * 60 * 1000

  return (
    <p className={`flex items-center gap-1.5 text-xs m-0 ${stale ? 'text-amber-600' : 'text-gray-400'}`}>
      <MdHistory className="text-sm shrink-0" />
      {last === null
        ? 'No previous backup yet.'
        : `Last backup completed ${formatTimeSince(last)}.`}
    </p>
  )
}
