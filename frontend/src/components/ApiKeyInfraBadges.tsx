import { useQuery } from '@tanstack/react-query'
import { MdDns } from 'react-icons/md'
import { listMyServers, resolveDrive } from '../api/storage'

export function useMyServers() {
  return useQuery({ queryKey: ['storage', 'my-servers'], queryFn: listMyServers })
}

// tierLabel matches the Fast/Standard convention used elsewhere in the app
// (see FileServerLinkModal and the storage upgrade views).
function tierLabel(driveType: 'nvme' | 'hdd'): string {
  return driveType === 'nvme' ? 'Fast' : 'Standard'
}

// ApiKeyInfraBadges shows which physical server + storage tier a scope's
// prefix will land on: the folder's pinned drive if it has one, otherwise
// the account's primary drive (today's dynamic-routing default — see
// resolveDrive in api/storage.ts, shared with the folder drive-change UI and
// upload modal so this reads the same way those do).
export function ApiKeyInfraBadges({ driveId }: { driveId: string | null | undefined }) {
  const { data: servers } = useMyServers()
  if (!servers) return null
  const { drive, isPinned } = resolveDrive(driveId, servers)
  if (!drive) return null
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-gray-600 bg-gray-100 rounded px-1.5 py-0.5">
        <MdDns className="text-gray-400" /> {drive.name}
      </span>
      <span
        className={`text-[10px] font-medium rounded px-1.5 py-0.5 ${
          drive.drive_type === 'nvme' ? 'text-emerald-700 bg-emerald-100' : 'text-sky-700 bg-sky-100'
        }`}
      >
        {tierLabel(drive.drive_type)}
      </span>
      {!isPinned && (
        <span
          className="text-[10px] text-gray-400"
          title="This folder isn't pinned to a drive — new files here use your primary drive by default."
        >
          (default)
        </span>
      )}
    </span>
  )
}
