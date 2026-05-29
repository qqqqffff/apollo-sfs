import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { MdContentCopy, MdLink, MdCheck, MdAdd } from 'react-icons/md'
import { listAPIKeys } from '../api/apiKeys'
import type { APIKey, APIKeyOperation } from '../types/api'

interface Props {
  // path is the slash-joined ancestor names ending at the folder being
  // shared, e.g. "photos/2024/birthday". Empty when sharing the root.
  path: string
  // folderId is informational only — used as the modal heading subtitle.
  folderName: string
  onClose: () => void
}

const ALL_OPS: APIKeyOperation[] = ['read', 'list', 'write', 'delete']

// ShareDirectoryModal shows the SFS path for a folder and which existing
// API keys grant which operations against it. If no keys cover the path,
// it offers a one-click jump to /settings/api-keys with the prefix
// pre-populated.
export function ShareDirectoryModal({ path, folderName, onClose }: Props) {
  const [copied, setCopied] = useState<'path' | 'curl' | null>(null)
  const [showAll, setShowAll] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const { data, isLoading } = useQuery({
    queryKey: ['api-keys', 'matching', path],
    queryFn: () => listAPIKeys(path),
  })

  const keys: APIKey[] = data?.items ?? []
  const matching = keys.filter((k) => (k.matching_operations?.length ?? 0) > 0)
  const visible = showAll ? keys : matching
  const hasCoverage = matching.length > 0

  const samplePath = path || 'your-file.txt'
  const curl = `curl -X POST https://<host>/api/v1/sfs/buckets/me/get \\
  -H "Authorization: Bearer sfs_<your_key>" \\
  -d '{"key": "${samplePath}"}'`

  async function copy(value: string, kind: 'path' | 'curl') {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(kind)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      // Clipboard API can fail in non-HTTPS contexts; fall back to a
      // textarea select so the user can copy manually.
      const ta = document.createElement('textarea')
      ta.value = value
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* noop */ }
      document.body.removeChild(ta)
      setCopied(kind)
      setTimeout(() => setCopied(null), 1500)
    }
  }

  function createKeyForThisPath() {
    navigate({
      to: '/settings/api-keys' as never,
      search: { prefix: path || '' } as never,
    })
  }

  return (
    <div onClick={onClose} className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-[560px] max-w-[92vw] p-6 flex flex-col gap-5"
      >
        <div className="flex items-start gap-3">
          <MdLink className="text-blue-500 text-2xl shrink-0 mt-0.5" />
          <div>
            <h3 className="text-base font-semibold text-gray-900 m-0 mb-1">Share &ldquo;{folderName}&rdquo;</h3>
            <p className="text-sm text-gray-500 m-0">
              Use the SFS API to read or write objects under this directory programmatically.
            </p>
          </div>
        </div>

        {/* Path field */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">SFS path</label>
          <div className="flex items-stretch gap-2">
            <input
              readOnly
              value={path || '(root)'}
              className="flex-1 px-3 py-2 text-sm font-mono border border-gray-200 rounded-lg bg-gray-50 text-gray-800"
            />
            <button
              onClick={() => copy(path, 'path')}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer transition-colors"
            >
              {copied === 'path' ? <MdCheck className="text-green-500" /> : <MdContentCopy />} Copy
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            Pass this as <code>key</code> (for a file under this dir) or <code>prefix</code> (for /list).
          </p>
        </div>

        {/* Curl sample */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">curl example</label>
          <div className="flex items-stretch gap-2">
            <pre className="flex-1 m-0 px-3 py-2 text-xs font-mono border border-gray-200 rounded-lg bg-gray-900 text-gray-100 whitespace-pre overflow-x-auto">
              {curl}
            </pre>
            <button
              onClick={() => copy(curl, 'curl')}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer transition-colors self-start"
            >
              {copied === 'curl' ? <MdCheck className="text-green-500" /> : <MdContentCopy />} Copy
            </button>
          </div>
        </div>

        {/* Keys table */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider">API keys</label>
            <button
              onClick={() => setShowAll((v) => !v)}
              className="text-xs text-blue-600 hover:underline bg-transparent border-0 p-0 cursor-pointer"
            >
              {showAll ? 'Show only matching' : `Show all (${keys.length})`}
            </button>
          </div>
          {isLoading ? (
            <p className="text-sm text-gray-400 m-0">Loading keys…</p>
          ) : visible.length === 0 ? (
            <div className="border border-dashed border-gray-200 rounded-lg p-4 text-center">
              <p className="text-sm text-gray-500 m-0 mb-3">
                {hasCoverage
                  ? 'No keys to show.'
                  : 'No API keys grant any access to this directory yet.'}
              </p>
              <button
                onClick={createKeyForThisPath}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
              >
                <MdAdd /> Create an API key for this directory
              </button>
            </div>
          ) : (
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold">Name</th>
                    <th className="text-left px-3 py-2 font-semibold">Operations</th>
                    <th className="text-left px-3 py-2 font-semibold">Last used</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((k) => (
                    <tr key={k.id} className="border-t border-gray-100">
                      <td className="px-3 py-2 text-gray-800">
                        {k.name}
                        <span className="ml-2 text-xs text-gray-400 font-mono">{k.key_prefix}</span>
                      </td>
                      <td className="px-3 py-2">
                        <OpsBadges
                          covered={k.matching_operations ?? []}
                        />
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500">
                        {k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 cursor-pointer transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function OpsBadges({ covered }: { covered: APIKeyOperation[] }) {
  const set = new Set(covered)
  return (
    <div className="flex gap-1">
      {ALL_OPS.map((op) => {
        const on = set.has(op)
        return (
          <span
            key={op}
            className={`px-1.5 py-0.5 text-[10px] font-mono uppercase rounded ${
              on ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'
            }`}
            title={on ? `Grants ${op}` : `Does not grant ${op}`}
          >
            {op}
          </span>
        )
      })}
    </div>
  )
}
