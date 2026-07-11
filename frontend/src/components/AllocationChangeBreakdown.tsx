import type { StorageAllocationChangeDetails } from '../types/api'

const GB = 1024 ** 3

function fmtGB(bytes: number): string {
  return `${(bytes / GB).toFixed(2)} GB`
}

// AllocationChangeBreakdown renders the full structured before/after per-drive
// breakdown (plus the admin's reason, if any) for a storage allocation change.
// Shared by NotificationBell (the affected user's "Breakdown" toggle) and
// AuditLogModal (the admin-facing audit trail) so both surfaces render the
// exact same detail from the exact same StorageAllocationChangeDetails JSON.
export function AllocationChangeBreakdown({ details }: { details: StorageAllocationChangeDetails }) {
  const ids = [...new Set([
    ...details.before.map((a) => a.drive_id),
    ...details.after.map((a) => a.drive_id),
  ])]

  return (
    <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50/60 p-2 text-xs">
      {details.reason && (
        <p className="italic text-gray-500 m-0 mb-1.5">&ldquo;{details.reason}&rdquo;</p>
      )}
      <table className="w-full border-collapse">
        <tbody>
          {ids.map((id) => {
            const before = details.before.find((a) => a.drive_id === id)
            const after = details.after.find((a) => a.drive_id === id)
            const label = after ?? before
            if (!label) return null
            return (
              <tr key={id}>
                <td className="pr-2 py-0.5 text-gray-600 whitespace-nowrap">
                  {label.server_name} ({label.drive_type === 'nvme' ? 'Fast' : 'Standard'})
                </td>
                <td className="py-0.5 text-gray-400 whitespace-nowrap">
                  {before ? fmtGB(before.quota_bytes) : 'added'}
                </td>
                <td className="px-1 py-0.5 text-gray-300">→</td>
                <td className="py-0.5 font-medium text-gray-700 whitespace-nowrap">
                  {after ? fmtGB(after.quota_bytes) : 'removed'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
