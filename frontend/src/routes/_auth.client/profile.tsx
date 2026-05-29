import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MdCheck, MdClose, MdPhotoLibrary } from 'react-icons/md'
import { meQueryOptions, changePassword, preferencesQueryOptions, updatePreferences } from '../../api/me'
import { listRoot } from '../../api/folders'
import { ApiError } from '../../api/client'

export const Route = createFileRoute('/_auth/client/profile')({
  component: RouteComponent,
})

const GB = 1024 ** 3

function formatSize(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

interface PasswordChecks {
  length: boolean
  upper: boolean
  number: boolean
  symbol: boolean
  match: boolean
}

function getChecks(newPassword: string, confirm: string): PasswordChecks {
  return {
    length: newPassword.length >= 8,
    upper: /[A-Z]/.test(newPassword),
    number: /[0-9]/.test(newPassword),
    symbol: /[^A-Za-z0-9]/.test(newPassword),
    match: newPassword.length > 0 && newPassword === confirm,
  }
}

function CheckItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 text-xs transition-colors ${ok ? 'text-green-600' : 'text-red-500'}`}>
      {ok ? <MdCheck className="shrink-0" /> : <MdClose className="shrink-0" />}
      {label}
    </li>
  )
}

function RouteComponent() {
  const { data: user, isLoading } = useQuery(meQueryOptions)

  const [current, setCurrent] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [touched, setTouched] = useState(false)
  const [pwError, setPwError] = useState<string | null>(null)
  const [pwSuccess, setPwSuccess] = useState(false)

  const checks = getChecks(newPw, confirm)
  const allValid = Object.values(checks).every(Boolean)

  const pwMutation = useMutation({
    mutationFn: () => changePassword(current, newPw),
    onSuccess: () => {
      setCurrent('')
      setNewPw('')
      setConfirm('')
      setTouched(false)
      setPwError(null)
      setPwSuccess(true)
      setTimeout(() => setPwSuccess(false), 4000)
    },
    onError: (err) => {
      setPwError(err instanceof ApiError ? err.message : 'Failed to change password')
    },
  })

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (!user) return null

  const pct = user.storage_quota_bytes > 0
    ? (user.storage_used_bytes / user.storage_quota_bytes) * 100
    : 0
  const barColor = pct >= 90 ? 'bg-red-500' : pct >= 50 ? 'bg-amber-400' : 'bg-green-500'

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-6 mt-0">Profile</h2>

      <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        <Row label="Username" value={user.username} />
        <Row label="Email" value={user.email} />
        <Row label="Account type" value={user.is_admin ? 'Admin' : 'User'} />
        <Row
          label="Member since"
          value={new Date(user.created_at).toLocaleDateString(undefined, {
            year: 'numeric', month: 'long', day: 'numeric',
          })}
        />
        <Row
          label="Last seen"
          value={user.last_seen_at
            ? new Date(user.last_seen_at).toLocaleString()
            : '—'}
        />
        <div className="px-5 py-4">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-gray-500">Storage</span>
            <span className="text-gray-700 font-medium">
              {formatSize(user.storage_used_bytes)}
              <span className="text-gray-400 font-normal"> / {formatSize(user.storage_quota_bytes)}</span>
            </span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${barColor}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-gray-400 mt-1.5">{pct.toFixed(1)}% used</p>
        </div>
      </div>

      <MediaAutoUpload />

      <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
        <h3 className="text-sm font-semibold text-gray-800 mb-4">Change password</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setPwError(null)
            setPwSuccess(false)
            pwMutation.mutate()
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">Current password</label>
            <input
              type="password"
              value={current}
              onChange={(e) => { setCurrent(e.target.value); setPwError(null) }}
              autoComplete="current-password"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">New password</label>
            <input
              type="password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              onFocus={() => setTouched(true)}
              autoComplete="new-password"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">Confirm new password</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onFocus={() => setTouched(true)}
              autoComplete="new-password"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {touched && (
            <ul className="space-y-1 pl-0.5">
              <CheckItem ok={checks.length} label="At least 8 characters" />
              <CheckItem ok={checks.upper}  label="One uppercase letter" />
              <CheckItem ok={checks.number} label="One number" />
              <CheckItem ok={checks.symbol} label="One symbol" />
              <CheckItem ok={checks.match}  label="Passwords match" />
            </ul>
          )}

          {pwError && <p className="text-xs text-red-500">{pwError}</p>}
          {pwSuccess && <p className="text-xs text-green-600">Password changed successfully.</p>}

          <button
            type="submit"
            disabled={!current || !allValid || pwMutation.isPending}
            className="self-start px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg disabled:opacity-50 transition-colors cursor-pointer"
          >
            {pwMutation.isPending ? 'Saving…' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  )
}

function MediaAutoUpload() {
  const queryClient = useQueryClient()
  const { data: prefs } = useQuery(preferencesQueryOptions)
  const { data: root } = useQuery({ queryKey: ['folders', 'root'], queryFn: () => listRoot() })
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const mediaFolders = (root?.subfolders?.items ?? []).filter((f) => f.kind === 'media')
  const enabled = !!prefs?.media_autoupload_folder_id

  const mutation = useMutation({
    mutationFn: (folderId: string | null) => updatePreferences(folderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['preferences'] })
      setError(null)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to save preference'),
  })

  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
      <h3 className="text-sm font-semibold text-gray-800 mb-1 flex items-center gap-1.5">
        <MdPhotoLibrary className="text-gray-500" /> Media auto-upload
      </h3>
      <p className="text-xs text-gray-400 mb-4">
        Automatically send every photo and video you upload to a chosen media collection.
      </p>

      {mediaFolders.length === 0 ? (
        <p className="text-xs text-gray-500">
          Create a media collection first to enable auto-upload.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => mutation.mutate(e.target.checked ? mediaFolders[0].id : null)}
              className="cursor-pointer"
            />
            Auto-upload photos &amp; videos to a collection
          </label>

          {enabled && (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Destination collection</label>
              <select
                value={prefs?.media_autoupload_folder_id ?? ''}
                onChange={(e) => mutation.mutate(e.target.value || null)}
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent cursor-pointer"
              >
                {mediaFolders.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}
          {saved && <p className="text-xs text-green-600">Preference saved.</p>}
        </div>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-5 py-3.5">
      <span className="text-sm text-gray-500">{label}</span>
      <span className="text-sm text-gray-900 font-medium">{value}</span>
    </div>
  )
}
