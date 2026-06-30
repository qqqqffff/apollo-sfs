import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MdCheck, MdClose, MdPhotoLibrary, MdRocketLaunch, MdKey, MdStorage, MdVpnKey, MdCloudUpload, MdSpeed } from 'react-icons/md'
import { FaGoogle, FaApple } from 'react-icons/fa'
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

  const [showUpgradeModal, setShowUpgradeModal] = useState(false)

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
        <Row label="Account type" value={user.is_admin ? 'Admin' : user.is_premium ? 'Premium' : 'User'} />
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

      <LinkedAccountsCard linkedProviders={user.linked_providers} />

      <PremiumCard
        isPremium={user.is_premium}
        isAdmin={user.is_admin}
        grantedAt={user.premium_granted_at}
        onUpgrade={() => setShowUpgradeModal(true)}
      />
      {showUpgradeModal && <PremiumUpgradeModal onClose={() => setShowUpgradeModal(false)} />}

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

function LinkedAccountsCard({ linkedProviders }: { linkedProviders: string[] }) {
  const providers = [
    { key: 'google', label: 'Google', icon: <FaGoogle className="text-[#4285F4]" /> },
    { key: 'apple',  label: 'Apple',  icon: <FaApple  className="text-gray-900" /> },
  ]
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
      <h3 className="text-sm font-semibold text-gray-800 mb-3">Linked accounts</h3>
      <div className="flex flex-col divide-y divide-gray-100">
        {providers.map(({ key, label, icon }) => {
          const linked = linkedProviders.includes(key)
          return (
            <div key={key} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <span className="text-lg w-5 flex items-center justify-center shrink-0">{icon}</span>
              <span className="text-sm text-gray-700 flex-1">{label}</span>
              {linked ? (
                <span className="flex items-center gap-1 text-xs font-medium text-green-600">
                  <MdCheck className="shrink-0" /> Connected
                </span>
              ) : (
                <span className="text-xs text-gray-400">Not connected</span>
              )}
            </div>
          )
        })}
      </div>
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

function PremiumCard({
  isPremium, isAdmin, grantedAt, onUpgrade,
}: { isPremium: boolean; isAdmin: boolean; grantedAt: string | null; onUpgrade: () => void }) {
  const navigate = useNavigate()
  if (isPremium || isAdmin) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
        <div className="flex items-start gap-3">
          <MdCheck className="text-green-500 text-xl shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-gray-800 m-0">Premium</h3>
            <p className="text-xs text-gray-500 m-0 mt-1">
              {isAdmin
                ? 'Included with your admin account.'
                : grantedAt ? `Activated on ${new Date(grantedAt).toLocaleDateString()}.` : 'Active.'}
            </p>
          </div>
          <button
            onClick={() => navigate({ to: '/settings/api-keys' as never })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 cursor-pointer transition-colors"
          >
            <MdKey /> Manage API keys
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="bg-amber-50 border-2 border-amber-200 rounded-xl px-5 py-4">
      <div className="flex items-start gap-3">
        <MdRocketLaunch className="text-amber-500 text-2xl shrink-0 mt-0.5" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-gray-900 m-0">Upgrade to Premium</h3>
          <p className="text-xs text-gray-600 m-0 mt-1">
            Unlocks the SFS S3-like API and per-directory API keys. One-time payment.
          </p>
        </div>
        <button
          onClick={onUpgrade}
          className="px-3 py-2 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
        >
          Upgrade
        </button>
      </div>
    </div>
  )
}

const PREMIUM_FEATURES = [
  {
    icon: MdStorage,
    title: 'Expanded storage quota',
    description: 'Get significantly more storage space for your files and media.',
  },
  {
    icon: MdVpnKey,
    title: 'Per-directory API keys',
    description: 'Issue scoped API keys tied to specific folders for fine-grained access control.',
  },
  {
    icon: MdCloudUpload,
    title: 'S3-compatible API',
    description: 'Access your files via an S3-like HTTP API — compatible with standard S3 clients and SDKs.',
  },
  {
    icon: MdSpeed,
    title: 'Priority support',
    description: 'Jump to the front of the queue when you need help from the SFS team.',
  },
]

function PremiumUpgradeModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const navigate = useNavigate()

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-120 max-w-[92vw] p-6 flex flex-col gap-5"
      >
        <div className="flex items-start gap-3">
          <MdRocketLaunch className="text-amber-500 text-2xl shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="text-base font-semibold text-gray-900 m-0">Upgrade to Premium</h3>
            <p className="text-sm text-gray-500 m-0 mt-1">One-time payment. No subscriptions.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 cursor-pointer transition-colors">
            <MdClose className="text-xl" />
          </button>
        </div>

        <ul className="flex flex-col gap-3 m-0 p-0 list-none">
          {PREMIUM_FEATURES.map(({ icon: Icon, title, description }) => (
            <li key={title} className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
                <Icon className="text-amber-500 text-base" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-800 m-0">{title}</p>
                <p className="text-xs text-gray-500 m-0 mt-0.5">{description}</p>
              </div>
            </li>
          ))}
        </ul>

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 cursor-pointer transition-colors"
          >
            Maybe later
          </button>
          <button
            onClick={() => { onClose(); navigate({ to: '/premium' as never }) }}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium cursor-pointer transition-colors"
          >
            Get Premium
          </button>
        </div>
      </div>
    </div>
  )
}
