import { useEffect, useMemo } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { MyServer } from '../api/storage'
import type { User } from '../types/api'

// Keeps the rest of the app in step with a backup that is still running: each
// stored file/email is credited to the quota caches immediately (no request —
// the size comes back on the upload response) and the file listing is
// refreshed so the item shows up in the browser as it lands.
//
// Listing refreshes are coalesced to REFRESH_INTERVAL_MS: a refetch per file
// would put the folder query — an infinite query that re-fetches every loaded
// page — back on the wire hundreds of times during a large backup, for a
// listing the user can't read that fast anyway. Quota credits are not
// throttled; they are local cache writes.
const REFRESH_INTERVAL_MS = 1500

export interface BackupLiveSync {
  // One file/email is now stored server-side.
  itemStored(item: { sizeBytes: number; driveId?: string | null }): void
  // Run finished (or was cancelled): reconcile everything against the server.
  finish(): void
}

export function createBackupLiveSync(
  queryClient: QueryClient,
  extraKeys: readonly (readonly unknown[])[] = [],
): BackupLiveSync {
  let lastRefresh = 0
  let pending: ReturnType<typeof setTimeout> | null = null

  function invalidateListings() {
    lastRefresh = Date.now()
    queryClient.invalidateQueries({ queryKey: ['folders'] })
    extraKeys.forEach((queryKey) => queryClient.invalidateQueries({ queryKey: queryKey as unknown[] }))
  }

  function refreshListings() {
    if (pending) return
    const wait = Math.max(0, REFRESH_INTERVAL_MS - (Date.now() - lastRefresh))
    if (wait === 0) { invalidateListings(); return }
    pending = setTimeout(() => { pending = null; invalidateListings() }, wait)
  }

  function creditQuota(bytes: number, driveId?: string | null) {
    if (bytes === 0) return
    queryClient.setQueryData<User>(['me'], (old) =>
      old ? { ...old, storage_used_bytes: Math.max(0, old.storage_used_bytes + bytes) } : old,
    )
    if (!driveId) return
    queryClient.setQueryData<MyServer[]>(['storage', 'my-servers'], (old) =>
      old?.map((s) => (s.drive_id === driveId
        ? { ...s, used_bytes: Math.max(0, s.used_bytes + bytes) }
        : s)),
    )
  }

  return {
    itemStored({ sizeBytes, driveId }) {
      creditQuota(sizeBytes, driveId)
      refreshListings()
    },
    finish() {
      if (pending) { clearTimeout(pending); pending = null }
      invalidateListings()
      // The optimistic credits above are estimates of the server's own
      // accounting (encryption overhead, per-drive routing); re-read both for
      // the authoritative numbers once the run is over.
      queryClient.invalidateQueries({ queryKey: ['me'] })
      queryClient.invalidateQueries({ queryKey: ['storage', 'my-servers'] })
    },
  }
}

// useBackupLiveSync is the hook form, for components that run a backup inline.
export function useBackupLiveSync(extraKeys: readonly (readonly unknown[])[] = []): BackupLiveSync {
  const queryClient = useQueryClient()
  // extraKeys is a literal at every call site; serialize it so a new array
  // identity per render doesn't rebuild the sync (and drop its throttle state).
  const keysId = JSON.stringify(extraKeys)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sync = useMemo(() => createBackupLiveSync(queryClient, extraKeys), [queryClient, keysId])
  useEffect(() => () => sync.finish(), [sync])
  return sync
}
