import { MdBolt, MdStorage } from 'react-icons/md'

// TierIcon is the compact icon-only way to show a drive's tier wherever the
// server name is already visible and a "Fast tier"/"Standard tier" text
// label would be redundant.
export function TierIcon({ type, className = 'text-sm' }: { type: 'nvme' | 'hdd'; className?: string }) {
  return type === 'nvme'
    ? <MdBolt className={`${className} text-blue-500 inline align-middle`} title="Fast tier" />
    : <MdStorage className={`${className} text-amber-500 inline align-middle`} title="Standard tier" />
}
