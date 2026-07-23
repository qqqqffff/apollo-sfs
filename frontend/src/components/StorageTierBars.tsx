import { MdBolt, MdStorage } from 'react-icons/md'
import type { MyServer } from '../api/storage'

// StorageTierBars renders one quota bar per drive (server & tier) the user owns
// — the granular breakdown shown at the file browser's "super level" (the root
// drive picker) above the drive list. Reuses the exact blue(nvme)/amber(hdd)
// colour vocabulary from the profile Servers list and the folder tier pickers.

function fmtSize(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function tierLabel(t: 'nvme' | 'hdd'): string {
  return t === 'nvme' ? 'Fast' : 'Standard'
}

export function StorageTierBars({ servers }: { servers: MyServer[] }) {
  if (servers.length === 0) return null
  return (
    <div className="flex flex-col gap-3 mb-5">
      {servers.map((s) => {
        const pct = s.quota_bytes > 0 ? Math.min((s.used_bytes / s.quota_bytes) * 100, 100) : 0
        const isFast = s.drive_type === 'nvme'
        return (
          <div key={s.drive_id}>
            <div className="flex items-center gap-1.5 mb-1 text-xs">
              {isFast
                ? <MdBolt className="text-blue-500 text-sm shrink-0" />
                : <MdStorage className="text-amber-500 text-sm shrink-0" />}
              <span className="font-medium text-gray-700">{tierLabel(s.drive_type)}</span>
              <span className="text-gray-400">· {s.name}</span>
              {s.is_primary && (
                <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-blue-50 text-blue-600 rounded">
                  Primary
                </span>
              )}
              <span className="ml-auto text-gray-400 tabular-nums">
                {fmtSize(s.used_bytes)} / {fmtSize(s.quota_bytes)}
              </span>
            </div>
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${isFast ? 'bg-blue-500' : 'bg-amber-400'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
