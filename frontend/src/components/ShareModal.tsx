import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MdCheck, MdClose, MdContentCopy, MdFolder, MdInsertDriveFile, MdShare } from 'react-icons/md'
import { createShare } from '../api/shares'
import { ApiError } from '../api/client'
import type { Share } from '../types/api'

interface Props {
  itemType: 'file' | 'folder'
  itemId: string
  itemName: string
  onClose: () => void
}

// Folder shares offer two modes per the sharing spec: view only, or
// view + upload + download. File shares are view-only with an optional
// download toggle.
type FolderMode = 'view' | 'edit'

// ShareModal creates a share of a file or folder addressed to a recipient
// email, then shows the resulting link for copying. The recipient must log in
// with that email before the link resolves.
export function ShareModal({ itemType, itemId, itemName, onClose }: Props) {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [canDownload, setCanDownload] = useState(false)
  const [folderMode, setFolderMode] = useState<FolderMode>('view')
  const [includeChildren, setIncludeChildren] = useState(true)
  const [notify, setNotify] = useState(true)
  const [created, setCreated] = useState<Share | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const shareMutation = useMutation({
    mutationFn: () =>
      createShare(
        itemType === 'file'
          ? {
              fileId: itemId,
              recipientEmail: email.trim(),
              canDownload,
              notify,
            }
          : {
              folderId: itemId,
              recipientEmail: email.trim(),
              canDownload: folderMode === 'edit',
              canUpload: folderMode === 'edit',
              includeChildren,
              notify,
            },
      ),
    onSuccess: (share) => {
      setCreated(share)
      setError(null)
      queryClient.invalidateQueries({ queryKey: ['shares', 'mine'] })
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Failed to create share')
    },
  })

  function submit() {
    if (!email.trim() || shareMutation.isPending) return
    shareMutation.mutate()
  }

  async function copyLink() {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.share_url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard unavailable — the link is visible for manual copying.
    }
  }

  return (
    <div onClick={onClose} className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden"
      >
        {/* header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2 min-w-0">
            <MdShare className="text-blue-500 text-lg shrink-0" />
            <span className="font-semibold text-gray-900 text-sm truncate">
              Share {itemType === 'file' ? 'file' : 'folder'}
            </span>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0.5">
            <MdClose className="text-xl" />
          </button>
        </div>

        <div className="px-5 py-4">
          <div className="flex items-center gap-2 mb-4 text-sm text-gray-700 min-w-0">
            {itemType === 'file'
              ? <MdInsertDriveFile className="text-gray-400 text-lg shrink-0" />
              : <MdFolder className="text-blue-400 text-lg shrink-0" />}
            <span className="truncate font-medium">{itemName}</span>
          </div>

          {created ? (
            <div>
              <p className="text-sm text-green-600 mb-3">
                Shared with <strong>{created.recipient_email}</strong>.
                They&apos;ll need to sign in with that email to open it.
              </p>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
                Share link
              </label>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={created.share_url}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 text-xs border border-gray-200 rounded-lg px-2.5 py-2 text-gray-700 bg-gray-50 min-w-0"
                />
                <button
                  onClick={copyLink}
                  title="Copy link"
                  className="inline-flex items-center gap-1 px-3 py-2 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 cursor-pointer transition-colors shrink-0"
                >
                  {copied ? <MdCheck className="text-green-500" /> : <MdContentCopy />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <button
                onClick={onClose}
                className="mt-4 w-full px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
              >
                Done
              </button>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
                Share with (email)
              </label>
              <input
                autoFocus
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
                placeholder="person@example.com"
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 text-gray-800 placeholder-gray-400 outline-none focus:border-blue-400 mb-4"
              />

              {itemType === 'file' ? (
                <Toggle
                  checked={canDownload}
                  onChange={setCanDownload}
                  label="Allow download"
                  hint="Off — they can only view the file in the app."
                />
              ) : (
                <>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                    Permissions
                  </label>
                  <div className="flex flex-col gap-1.5 mb-3">
                    <ModeRadio
                      selected={folderMode === 'view'}
                      onSelect={() => setFolderMode('view')}
                      label="View only"
                      hint="They can browse and view files, nothing else."
                    />
                    <ModeRadio
                      selected={folderMode === 'edit'}
                      onSelect={() => setFolderMode('edit')}
                      label="View, upload & download"
                      hint="They can also download files and upload new ones."
                    />
                  </div>
                  <Toggle
                    checked={includeChildren}
                    onChange={setIncludeChildren}
                    label="Include subfolders"
                    hint="Off — only this folder's own files are shared."
                  />
                </>
              )}

              <Toggle
                checked={notify}
                onChange={setNotify}
                label="Send email notification"
                hint="Emails the recipient a link to the shared item."
              />

              {error && <p className="text-xs text-red-500 mt-1 mb-2">{error}</p>}

              <button
                onClick={submit}
                disabled={!email.trim() || shareMutation.isPending}
                className="mt-3 w-full px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {shareMutation.isPending ? 'Sharing…' : 'Create share link'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Toggle({ checked, onChange, label, hint }: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <label className="flex items-start gap-2.5 mb-3 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-blue-600 cursor-pointer"
      />
      <span className="min-w-0">
        <span className="block text-sm text-gray-800">{label}</span>
        {hint && <span className="block text-xs text-gray-400">{hint}</span>}
      </span>
    </label>
  )
}

function ModeRadio({ selected, onSelect, label, hint }: {
  selected: boolean
  onSelect: () => void
  label: string
  hint: string
}) {
  return (
    <label className="flex items-start gap-2.5 cursor-pointer select-none">
      <input
        type="radio"
        checked={selected}
        onChange={onSelect}
        className="mt-0.5 accent-blue-600 cursor-pointer"
      />
      <span className="min-w-0">
        <span className="block text-sm text-gray-800">{label}</span>
        <span className="block text-xs text-gray-400">{hint}</span>
      </span>
    </label>
  )
}
