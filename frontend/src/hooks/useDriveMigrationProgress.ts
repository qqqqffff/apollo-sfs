import { useQuery } from '@tanstack/react-query'
import { getLatestDriveMigration } from '../api/folders'
import type { FolderDriveMigration, FolderDriveMigrationStatus } from '../types/api'
import type { UploadProgress, UploadStatus, FileItemStatus } from './useFileUpload'

const POLL_MS = 1500

const STATUS_MAP: Record<FolderDriveMigrationStatus, UploadStatus> = {
  pending: 'uploading',
  in_progress: 'uploading',
  completed: 'complete',
  failed: 'allFailed',
}

const ITEM_STATUS_MAP: Record<FolderDriveMigrationStatus, FileItemStatus> = {
  pending: 'uploading',
  in_progress: 'uploading',
  completed: 'done',
  failed: 'failed',
}

function toUploadProgress(migration: FolderDriveMigration, folderName: string): UploadProgress {
  const status = STATUS_MAP[migration.status]
  return {
    status,
    items: [{
      name: folderName,
      size: migration.total_bytes,
      loaded: migration.bytes_moved,
      status: ITEM_STATUS_MAP[migration.status],
    }],
    totalBytes: migration.total_bytes,
    loadedBytes: migration.bytes_moved,
    // No backend field for transfer rate — not worth estimating client-side.
    speedBps: 0,
    succeeded: migration.status === 'completed' ? 1 : 0,
    failed: migration.status === 'failed' ? 1 : 0,
  }
}

// useDriveMigrationProgress polls the latest-migration endpoint for a folder
// while a drive change is pending/in_progress, and maps the response into the
// existing UploadProgress shape so it can be rendered with <UploadToast/>
// (one synthetic item representing the whole folder's move).
export function useDriveMigrationProgress(folderId: string | null, folderName: string) {
  const { data } = useQuery({
    queryKey: ['folders', folderId, 'drive-migration'],
    queryFn: () => getLatestDriveMigration(folderId!),
    enabled: folderId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.migration?.status
      return status === 'pending' || status === 'in_progress' ? POLL_MS : false
    },
  })

  const migration = data?.migration ?? null
  const progress: UploadProgress | null = migration ? toUploadProgress(migration, folderName) : null
  const isActive = migration?.status === 'pending' || migration?.status === 'in_progress'

  return { eligibility: data, migration, progress, isActive }
}
