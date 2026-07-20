import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MdCheckCircle,
  MdClose,
  MdContentCopy,
  MdDns,
  MdExpandLess,
  MdExpandMore,
  MdLink,
  MdShield,
} from 'react-icons/md'
import { listMyServers, type MyServer } from '../api/storage'
import { createFileServerLink, type FileServerLink } from '../api/fileServerLinks'
import { ApiError } from '../api/client'

// ── Device detection for the personalized mount guide ─────────────────────────

export type DeviceOS = 'windows' | 'macos' | 'ios' | 'android' | 'linux'

// detectDeviceOS inspects the user agent; Linux (Ubuntu) is the fallback when
// the device cannot be discerned.
export function detectDeviceOS(ua: string = navigator.userAgent): DeviceOS {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  if (/Windows/i.test(ua)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos'
  return 'linux'
}

const OS_LABELS: Record<DeviceOS, string> = {
  windows: 'Windows',
  macos: 'macOS',
  ios: 'iPhone / iPad',
  android: 'Android',
  linux: 'Linux (Ubuntu)',
}

// Mount instructions per device. {URL} is replaced with the link's mount URL.
const GUIDES: Record<DeviceOS, string[]> = {
  windows: [
    'Open File Explorer and right-click "This PC", then choose "Map network drive…".',
    'Pick a drive letter, paste the link below into "Folder", and tick "Connect using different credentials".',
    'Click Finish, then sign in with your Apollo SFS username (not your email address) and password when prompted.',
    'The file server appears as a network drive — drag files onto it to upload, or copy them off it to download.',
  ],
  macos: [
    'In Finder, press ⌘K (or choose Go → "Connect to Server…").',
    'Paste the link below into the server address field and click Connect.',
    'Choose "Registered User" and sign in with your Apollo SFS username and password.',
    'The file server mounts under Locations in Finder — copy files to it to upload, or from it to download.',
  ],
  ios: [
    'Open the Files app and tap the ⋯ (three dots) button, then "Connect to Server".',
    'Paste the link below and tap Connect.',
    'Choose "Registered User" and sign in with your Apollo SFS username and password.',
    'The file server appears under Shared in Files — use it to upload and download files.',
  ],
  android: [
    'Install a file manager with WebDAV support (e.g. Cx File Explorer or Solid Explorer).',
    'Add a new network / cloud location and choose WebDAV.',
    'Paste the link below as the address and sign in with your Apollo SFS username and password.',
    'The file server appears as a storage location — use it to upload and download files.',
  ],
  linux: [
    'On Ubuntu, open Files (Nautilus) and choose "Other Locations" in the sidebar.',
    'Paste the link below into "Connect to Server" at the bottom, replacing https:// with davs://, then click Connect.',
    'Sign in with your Apollo SFS username and password.',
    'Alternatively, install davfs2 (sudo apt install davfs2) and run: sudo mount -t davfs <link> /mnt/apollo.',
  ],
}

// MountGuide renders the toggleable per-device instructions accordion shown
// inside the modal (auto-expanded on first-time link creation).
export function MountGuide({ mountUrl, defaultOpen }: { mountUrl: string | null; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const [os, setOS] = useState<DeviceOS>(() => detectDeviceOS())

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-gray-50 hover:bg-gray-100 transition-colors cursor-pointer border-0 text-left"
      >
        <span className="text-xs font-semibold text-gray-700">
          How to mount on your device ({OS_LABELS[os]})
        </span>
        {open ? <MdExpandLess className="text-gray-500" /> : <MdExpandMore className="text-gray-500" />}
      </button>
      {open && (
        <div className="px-3 py-3 space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(OS_LABELS) as DeviceOS[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setOS(key)}
                className={`px-2 py-1 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                  os === key
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
              >
                {OS_LABELS[key]}
              </button>
            ))}
          </div>
          <ol className="list-decimal pl-4 space-y-1.5 m-0">
            {GUIDES[os].map((step, i) => (
              <li key={i} className="text-xs text-gray-600 leading-relaxed">{step}</li>
            ))}
          </ol>
          {os === 'windows' && (
            <div className="text-[11px] text-gray-500 bg-amber-50 border border-amber-100 rounded-md px-2.5 py-2 space-y-1">
              <p className="font-semibold text-amber-700 m-0">Troubleshooting</p>
              <p className="m-0">
                <strong>"Windows cannot access… Error 0x80070043, the network name cannot be found"</strong> — the
                WebClient service (Windows' built-in WebDAV client) isn't running. Open <code>services.msc</code>,
                find <strong>WebClient</strong>, set it to Automatic, and start it, then retry.
              </p>
              <p className="m-0">
                <strong>Credentials keep getting rejected, or Windows shows "Microsoft Account\your@email"</strong> —
                sign in with your Apollo SFS <strong>username</strong>, not your email address. Typing an email
                address that matches a Microsoft account signed into the PC can cause Windows to substitute its own
                account instead of sending what you typed. If a wrong entry got cached, remove it first via Control
                Panel → Credential Manager → Windows Credentials (look for an entry for apollo-sfs.com).
              </p>
            </div>
          )}
          {mountUrl && (
            <div className="text-[11px] text-gray-500 bg-gray-50 rounded-md px-2 py-1.5 font-mono break-all">
              {mountUrl}
            </div>
          )}
          <p className="text-[11px] text-gray-400 m-0">
            You can upload, download, rename, move, copy and delete files through the
            mount — but files are never previewed or executed on the server.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void
  // Links that already exist, so the picker can flag drives that have one.
  existingLinks: FileServerLink[]
}

// tierLabel matches the Fast/Standard convention used elsewhere in the app
// (see the storage upgrade and admin drive-usage views).
function tierLabel(driveType: 'nvme' | 'hdd'): string {
  return driveType === 'nvme' ? 'Fast' : 'Standard'
}

export function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text)
}

interface CreateFormProps {
  existingLinks: FileServerLink[]
  // First-time creation (no links existed before) auto-expands the guide.
  isFirstLink: boolean
}

// FileServerLinkCreateForm is the picker + creation flow, with no backdrop or
// header of its own — reusable both inside the standalone FileServerLinkModal
// (own backdrop, used from the profile page) and embedded directly inside a
// host modal's own single-backdrop shell (used from the files sidebar), so
// the two entry points never stack two dimmed backdrops on top of each other.
export function FileServerLinkCreateForm({ existingLinks, isFirstLink }: CreateFormProps) {
  const queryClient = useQueryClient()
  const { data: servers = [], isLoading } = useQuery({
    queryKey: ['storage', 'my-servers'],
    queryFn: listMyServers,
  })

  const [selected, setSelected] = useState<string | null>(null)
  const [enhanced, setEnhanced] = useState(false)
  const [result, setResult] = useState<{ link: FileServerLink; created: boolean } | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const linkByDrive = useMemo(() => {
    const m = new Map<string, FileServerLink>()
    for (const l of existingLinks) m.set(l.drive_id, l)
    return m
  }, [existingLinks])

  const existingForSelected = selected ? linkByDrive.get(selected) : undefined

  const createMutation = useMutation({
    mutationFn: () => createFileServerLink(selected!, enhanced),
    onSuccess: async (res) => {
      setResult(res)
      setError(null)
      queryClient.invalidateQueries({ queryKey: ['file-server-links'] })
      try {
        await copyToClipboard(res.link.mount_url)
        setCopied(true)
      } catch {
        setCopied(false)
      }
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Failed to create link')
    },
  })

  return (
    <div className="space-y-4">
      {result?.created ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-green-600 text-sm font-medium">
            <MdCheckCircle className="text-lg shrink-0" />
            Link created{copied ? ' and copied to your clipboard' : ''}
          </div>
          <LinkDisplay link={result.link} />
          <MountGuide mountUrl={result.link.mount_url} defaultOpen={isFirstLink} />
        </div>
      ) : (
        <>
          <p className="text-xs text-gray-500 m-0">
            Pick one of your storage servers and its tier. The link mounts that specific
            drive as a network drive on your device — you'll sign in with your Apollo SFS
            credentials when connecting. A server exposing both Fast and Standard tiers to
            you can have a separate link for each; only one link can exist per drive.
          </p>

          {isLoading && <p className="text-xs text-gray-400">Loading your servers…</p>}
          {!isLoading && servers.length === 0 && (
            <p className="text-xs text-gray-400">You have no storage servers yet.</p>
          )}

          <div className="space-y-2">
            {servers.map((srv: MyServer) => {
              const has = linkByDrive.has(srv.drive_id)
              const isSel = selected === srv.drive_id
              return (
                <button
                  key={srv.drive_id}
                  type="button"
                  onClick={() => { setSelected(srv.drive_id); setError(null) }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                    isSel ? 'border-blue-500 bg-blue-50/50' : 'border-gray-200 bg-white hover:border-gray-300'
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <MdDns className={`shrink-0 ${isSel ? 'text-blue-600' : 'text-gray-400'}`} />
                    <span className="text-sm text-gray-800 truncate">{srv.name}</span>
                    <span
                      className={`text-[10px] font-medium rounded px-1.5 py-0.5 shrink-0 ${
                        srv.drive_type === 'nvme'
                          ? 'text-emerald-700 bg-emerald-100'
                          : 'text-sky-700 bg-sky-100'
                      }`}
                    >
                      {tierLabel(srv.drive_type)}
                    </span>
                    {srv.is_primary && (
                      <span className="text-[10px] font-medium text-blue-600 bg-blue-50 rounded px-1.5 py-0.5">primary</span>
                    )}
                  </span>
                  {has && (
                    <span className="text-[10px] font-medium text-amber-600 bg-amber-50 rounded px-1.5 py-0.5 shrink-0">
                      link exists
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {existingForSelected ? (
            <div className="space-y-3">
              <p className="text-xs text-amber-600 m-0">
                A link already exists for this drive. You can copy it below, or delete it
                from your profile page to create a new one.
              </p>
              <LinkDisplay link={existingForSelected} />
              <MountGuide mountUrl={existingForSelected.mount_url} defaultOpen={false} />
            </div>
          ) : (
            <>
              <label className="flex items-start gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={enhanced}
                  onChange={(e) => setEnhanced(e.target.checked)}
                  className="mt-0.5 accent-blue-600"
                />
                <span>
                  <span className="flex items-center gap-1 text-xs font-medium text-gray-700">
                    <MdShield className="text-blue-600" /> Enhanced security mode
                  </span>
                  <span className="block text-[11px] text-gray-400 mt-0.5">
                    Uploads and downloads from a new location (or every 30 days from a known
                    one) require clicking a verification link sent to your email while signed in.
                  </span>
                </span>
              </label>

              {error && <p className="text-xs text-red-500 m-0">{error}</p>}

              <button
                type="button"
                disabled={!selected || createMutation.isPending}
                onClick={() => createMutation.mutate()}
                className="w-full px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg disabled:opacity-50 transition-colors cursor-pointer"
              >
                {createMutation.isPending ? 'Creating…' : 'Generate link & copy to clipboard'}
              </button>

              <MountGuide mountUrl={null} defaultOpen={false} />
            </>
          )}
        </>
      )}
    </div>
  )
}

// FileServerLinkModal is the standalone entry point (own backdrop + header)
// used from the profile page, where there is no host modal already dimming
// the background.
export function FileServerLinkModal({ onClose, existingLinks }: Props) {
  const isFirstLink = existingLinks.length === 0

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-130 max-w-[94vw] max-h-[90vh] flex flex-col overflow-y-auto"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-800 m-0 flex items-center gap-2">
            <MdLink className="text-blue-600 text-base" /> New file server link
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 bg-transparent border-0 p-0 cursor-pointer"
            aria-label="Close"
          >
            <MdClose className="text-lg" />
          </button>
        </div>

        <div className="px-5 py-4">
          <FileServerLinkCreateForm existingLinks={existingLinks} isFirstLink={isFirstLink} />
        </div>
      </div>
    </div>
  )
}

// LinkDisplay shows a mount URL with a copy button.
export function LinkDisplay({ link }: { link: FileServerLink }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 text-[11px] text-gray-700 bg-gray-50 border border-gray-200 rounded-md px-2 py-1.5 break-all">
        {link.mount_url}
      </code>
      <button
        type="button"
        onClick={async () => {
          try {
            await copyToClipboard(link.mount_url)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          } catch { /* clipboard unavailable */ }
        }}
        className="shrink-0 inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium text-gray-600 hover:text-gray-800 bg-white border border-gray-200 rounded-md cursor-pointer transition-colors"
      >
        {copied ? <MdCheckCircle className="text-green-600" /> : <MdContentCopy />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
