import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { IconType } from 'react-icons'
import {
  MdAdd, MdClose, MdContentCopy, MdCheck, MdDelete, MdEdit,
  MdFormatListBulleted, MdInfoOutline, MdKey, MdKeyboardArrowDown, MdStars, MdUpload, MdVisibility,
  MdWarning,
} from 'react-icons/md'
import { createAPIKey, listAPIKeys, revokeAPIKey, updateAPIKey } from '../../api/apiKeys'
import { resolvePathToFolder } from '../../api/folders'
import { meQueryOptions } from '../../api/me'
import { FolderPrefixPicker } from '../../components/FolderPrefixPicker'
import { ApiKeyInfraBadges, useMyServers } from '../../components/ApiKeyInfraBadges'
import {
  API_KEY_DEFAULT_RATE_LIMIT_PER_MIN, API_KEY_MAX_RATE_LIMIT_PER_MIN, API_KEY_MAX_TTL_DAYS,
} from '../../types/api'
import type { APIKey, APIKeyOperation, APIKeyScope, Folder, IssuedAPIKey } from '../../types/api'

const OPS: APIKeyOperation[] = ['read', 'list', 'write', 'delete']

// 'all' is a form-only convenience value — there's no wildcard operation
// server-side (see api/routes/services/api_key.go's validOperations). A
// scope row set to 'all' is expanded into the four real operations before
// the request is sent (see scopesToPayload) and collapsed back into a
// single row when an existing key with all four is opened for editing (see
// collapseScopesForEdit).
type LocalOperation = APIKeyOperation | 'all'

const OPERATION_META: Record<LocalOperation, { label: string; icon: IconType; badgeClass: string }> = {
  read: { label: 'Read', icon: MdVisibility, badgeClass: 'bg-blue-100 text-blue-700' },
  list: { label: 'List', icon: MdFormatListBulleted, badgeClass: 'bg-purple-100 text-purple-700' },
  write: { label: 'Write', icon: MdUpload, badgeClass: 'bg-green-100 text-green-700' },
  delete: { label: 'Delete', icon: MdDelete, badgeClass: 'bg-red-100 text-red-700' },
  all: { label: 'All actions', icon: MdStars, badgeClass: 'bg-amber-100 text-amber-700' },
}

const OPERATION_PICKER_OPTIONS: LocalOperation[] = [...OPS, 'all']

// scopesToPayload expands any 'all actions' rows into the four discrete
// operations the API understands and dedupes so the same operation+prefix
// pair (e.g. from two overlapping rows) isn't sent twice.
function scopesToPayload(scopes: { operation: LocalOperation; path_prefix: string }[]): APIKeyScope[] {
  const seen = new Set<string>()
  const out: APIKeyScope[] = []
  for (const s of scopes) {
    const ops = s.operation === 'all' ? OPS : [s.operation]
    for (const op of ops) {
      const key = `${op}:${s.path_prefix}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ operation: op, path_prefix: s.path_prefix })
    }
  }
  return out
}

// collapseScopesForEdit is scopesToPayload's inverse: groups a persisted
// key's scopes by path_prefix and folds any group covering all four base
// operations back into a single 'all actions' row, so a key created via the
// star option round-trips cleanly when reopened for editing.
function collapseScopesForEdit(scopes: APIKeyScope[]): { operation: LocalOperation; path_prefix: string }[] {
  const byPrefix = new Map<string, APIKeyScope[]>()
  for (const s of scopes) {
    const list = byPrefix.get(s.path_prefix) ?? []
    list.push(s)
    byPrefix.set(s.path_prefix, list)
  }
  const rows: { operation: LocalOperation; path_prefix: string }[] = []
  for (const [prefix, group] of byPrefix) {
    const ops = new Set(group.map((s) => s.operation))
    if (group.length === OPS.length && OPS.every((op) => ops.has(op))) {
      rows.push({ operation: 'all', path_prefix: prefix })
    } else {
      for (const s of group) rows.push({ operation: s.operation, path_prefix: prefix })
    }
  }
  return rows
}

// The API's public domain — used in code samples so they can be copy-pasted
// verbatim instead of requiring a find-and-replace on a <your-domain>
// placeholder.
const APP_DOMAIN = 'https://apollo-sfs.com'

// Remembers that the user has dismissed the getting-started guide so it
// doesn't reopen automatically after they revoke their last key.
const GUIDE_DISMISSED_KEY = 'apollo_apikey_guide_dismissed'

interface Search {
  // When present, the create form is pre-opened and prefilled with this prefix.
  // Used by the share-directory modal's "Create a key for this directory" CTA.
  prefix?: string
}

export const Route = createFileRoute('/_auth/settings/api-keys')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    prefix: typeof search.prefix === 'string' ? search.prefix : undefined,
  }),
  component: RouteComponent,
})

function RouteComponent() {
  const { data: user } = useQuery(meQueryOptions)
  const navigate = useNavigate()
  const search = useSearch({ from: '/_auth/settings/api-keys' })
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['api-keys'], queryFn: () => listAPIKeys() })
  const [creating, setCreating] = useState(search.prefix !== undefined)
  const [editingKey, setEditingKey] = useState<APIKey | null>(null)
  const [issued, setIssued] = useState<IssuedAPIKey | null>(null)
  const [copiedIssued, setCopiedIssued] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)

  useEffect(() => {
    if (search.prefix !== undefined) setCreating(true)
  }, [search.prefix])

  // Auto-open the guide the first time a premium/admin user lands here with
  // no keys yet. Once dismissed it only comes back via the info button.
  useEffect(() => {
    if (
      !isLoading && data && (user?.is_premium || user?.is_admin) &&
      data.items.length === 0 && !localStorage.getItem(GUIDE_DISMISSED_KEY)
    ) {
      setGuideOpen(true)
    }
  }, [isLoading, data, user])

  const dismissGuide = () => {
    setGuideOpen(false)
    localStorage.setItem(GUIDE_DISMISSED_KEY, '1')
  }

  const revoke = useMutation({
    mutationFn: (id: string) => revokeAPIKey(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
  })

  if (!user) return <p className="text-sm text-gray-500">Loading…</p>

  if (!user.is_premium && !user.is_admin) {
    return (
      <div className="max-w-xl mx-auto">
        <h1 className="text-xl font-semibold text-gray-900">API Keys</h1>
        <div className="mt-6 p-6 rounded-xl border-2 border-amber-200 bg-amber-50">
          <p className="text-sm text-gray-700 m-0 mb-4">
            API keys for the SFS S3-like API are part of the Premium tier.
          </p>
          <button
            onClick={() => navigate({ to: '/premium' as never })}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
          >
            Upgrade to Premium
          </button>
        </div>
      </div>
    )
  }

  const keys = data?.items ?? []
  const formOpen = creating || editingKey !== null

  function closeForm() {
    setCreating(false)
    setEditingKey(null)
    navigate({ to: '/settings/api-keys' as never, search: {} as never, replace: true })
  }

  return (
    <div className="max-w-3xl mx-auto" data-tour="api-keys-list">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gray-900 m-0">API Keys</h1>
        {!formOpen && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setGuideOpen(true)}
              title="How API keys work"
              aria-label="How API keys work"
              className="inline-flex items-center justify-center w-9 h-9 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg border border-gray-200 cursor-pointer transition-colors"
            >
              <MdInfoOutline className="text-lg" />
            </button>
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
            >
              <MdAdd /> New key
            </button>
          </div>
        )}
      </div>

      {guideOpen && <ApiKeyGuideModal onClose={dismissGuide} />}

      {issued && (
        <NewKeyBanner
          issued={issued}
          copied={copiedIssued}
          onCopy={async () => {
            try {
              await navigator.clipboard.writeText(issued.raw_key)
              setCopiedIssued(true)
              setTimeout(() => setCopiedIssued(false), 1500)
            } catch { /* noop */ }
          }}
          onDismiss={() => setIssued(null)}
        />
      )}

      {formOpen && (
        <KeyForm
          initial={editingKey}
          initialPrefix={search.prefix ?? ''}
          onCreated={(k) => {
            setIssued(k)
            closeForm()
            queryClient.invalidateQueries({ queryKey: ['api-keys'] })
          }}
          onUpdated={() => {
            closeForm()
            queryClient.invalidateQueries({ queryKey: ['api-keys'] })
          }}
          onCancel={closeForm}
        />
      )}

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading keys…</p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-gray-400">You don&rsquo;t have any API keys yet.</p>
      ) : (
        <ul className="list-none p-0 m-0 flex flex-col gap-3">
          {keys.map((k) => (
            <KeyCard
              key={k.id}
              apiKey={k}
              onEdit={() => setEditingKey(k)}
              onRevoke={() => { if (confirm(`Revoke ${k.name}? This cannot be undone.`)) revoke.mutate(k.id) }}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function KeyCard({
  apiKey: k, onEdit, onRevoke,
}: { apiKey: APIKey; onEdit: () => void; onRevoke: () => void }) {
  const [infoOpen, setInfoOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const sample = sampleQueryText(k)

  async function copySample() {
    try {
      await navigator.clipboard.writeText(sample)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* noop */ }
  }

  return (
    <li className="border border-gray-200 rounded-xl p-4 bg-white">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <MdKey className="text-gray-400" />
            <span className="font-semibold text-gray-900 truncate">{k.name}</span>
            <span className="text-xs font-mono text-gray-400 truncate">{k.key_prefix}</span>
            {k.revoked_at && (
              <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-red-100 text-red-700 rounded">Revoked</span>
            )}
          </div>
          <div className="text-xs text-gray-500 mb-2">
            Created {new Date(k.created_at).toLocaleDateString()}
            {k.last_used_at && ` • last used ${new Date(k.last_used_at).toLocaleString()}`}
            {k.expires_at && ` • expires ${new Date(k.expires_at).toLocaleDateString()}`}
            {` • ${k.rate_limit_per_min}/min`}
          </div>
          <ScopeList scopes={k.scopes ?? []} />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setInfoOpen((o) => !o)}
            title="Sample query"
            aria-expanded={infoOpen}
            className={`cursor-pointer bg-transparent border-0 p-1 transition-colors ${infoOpen ? 'text-blue-600' : 'text-gray-400 hover:text-gray-700'}`}
          >
            <MdInfoOutline className="text-lg" />
          </button>
          {!k.revoked_at && (
            <>
              <button
                onClick={onEdit}
                title="Edit key"
                className="text-gray-400 hover:text-gray-700 cursor-pointer bg-transparent border-0 p-1 transition-colors"
              >
                <MdEdit className="text-lg" />
              </button>
              <button
                onClick={onRevoke}
                title="Revoke key"
                className="text-red-500 hover:text-red-700 cursor-pointer bg-transparent border-0 p-1 transition-colors"
              >
                <MdDelete className="text-lg" />
              </button>
            </>
          )}
        </div>
      </div>

      {infoOpen && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-gray-700">Sample query</span>
            <button
              onClick={copySample}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 border border-gray-200 rounded-md hover:bg-gray-50 cursor-pointer transition-colors"
            >
              {copied ? <MdCheck className="text-green-500" /> : <MdContentCopy />} Copy
            </button>
          </div>
          <textarea
            readOnly
            value={sample}
            rows={sample.split('\n').length}
            onFocus={(e) => e.target.select()}
            className="w-full bg-gray-900 text-gray-100 text-[11px] font-mono rounded-lg p-3 resize-none focus:outline-none"
          />
          <p className="text-[11px] text-gray-400 m-0 mt-1">
            Replace <code className="font-mono">&lt;YOUR_SECRET&gt;</code> with the secret you saved when this key was created — it can&rsquo;t be shown again.
          </p>
        </div>
      )}
    </li>
  )
}

// sampleQueryText builds copy-pasteable curl examples for every scope on an
// already-issued key. The raw secret is only ever shown once at creation
// (see NewKeyBanner), so this substitutes a placeholder into the real
// `sfs_<prefix>_<secret>` token shape instead of the actual key.
function sampleQueryText(k: APIKey): string {
  const placeholderKey = `sfs_${k.key_prefix}_<YOUR_SECRET>`
  const scopes = k.scopes ?? []
  if (scopes.length === 0) return 'This key has no scopes, so it cannot be used for requests.'
  return scopes
    .map((s) => sampleRequest(s.operation, s.path_prefix, placeholderKey))
    .join('\n\n')
}

function NewKeyBanner({
  issued, copied, onCopy, onDismiss,
}: { issued: IssuedAPIKey; copied: boolean; onCopy: () => void; onDismiss: () => void }) {
  return (
    <div className="mb-6 border-2 border-amber-300 bg-amber-50 rounded-xl p-4">
      <div className="flex items-start gap-2 mb-3">
        <MdWarning className="text-amber-500 text-xl shrink-0 mt-0.5" />
        <div>
          <h2 className="text-sm font-semibold text-gray-900 m-0">Save this key now</h2>
          <p className="text-xs text-gray-600 m-0 mt-1">
            This is the only time the full key is shown. Store it somewhere safe — we only keep its hash on our servers.
          </p>
        </div>
      </div>
      <div className="flex items-stretch gap-2 mb-3">
        <input
          readOnly
          value={issued.raw_key}
          className="flex-1 px-3 py-2 text-sm font-mono border border-amber-300 rounded-lg bg-white text-gray-900"
        />
        <button
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-amber-300 bg-white rounded-lg hover:bg-amber-100 cursor-pointer transition-colors"
        >
          {copied ? <MdCheck className="text-green-500" /> : <MdContentCopy />} Copy
        </button>
      </div>

      {issued.key.scopes && issued.key.scopes.length > 0 && (
        <div className="mb-3">
          <p className="text-xs font-semibold text-gray-700 m-0 mb-2">Sample requests for this key&rsquo;s scopes</p>
          <div className="flex flex-col gap-2">
            {issued.key.scopes.map((s) => (
              <div key={s.id ?? `${s.operation}:${s.path_prefix}`}>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="px-1.5 py-0.5 text-[10px] font-mono uppercase rounded bg-blue-100 text-blue-700">{s.operation}</span>
                  <span className="text-[11px] font-mono text-gray-500">{s.path_prefix || '/'}</span>
                </div>
                <pre className="m-0 bg-gray-900 text-gray-100 text-[11px] rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
                  {sampleRequest(s.operation, s.path_prefix, issued.raw_key)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={onDismiss}
        className="text-xs text-gray-500 hover:text-gray-700 bg-transparent border-0 p-0 cursor-pointer"
      >
        I&rsquo;ve saved it. Dismiss.
      </button>
    </div>
  )
}

// sampleRequest builds a copy-pasteable curl example for one scope, using the
// operation to pick the right SFS endpoint (see docs/sfs_api.md) and the
// scope's own path_prefix so the example actually falls inside what the key
// is allowed to touch.
function sampleRequest(op: APIKeyOperation, prefix: string, rawKey: string): string {
  const base = `${APP_DOMAIN}/api/v1/sfs/buckets/me`
  const examplePath = prefix ? `${prefix}/example.txt` : 'example.txt'
  switch (op) {
    case 'write':
      return `curl -X POST ${base}/put \\\n  -H "Authorization: Bearer ${rawKey}" \\\n  -d '{"key":"${examplePath}","content_type":"text/plain","size_bytes":12}'`
    case 'read':
      return `curl -X POST ${base}/get \\\n  -H "Authorization: Bearer ${rawKey}" \\\n  -d '{"key":"${examplePath}"}'`
    case 'delete':
      return `curl -X POST ${base}/delete \\\n  -H "Authorization: Bearer ${rawKey}" \\\n  -d '{"key":"${examplePath}"}'`
    case 'list':
      return `curl -X POST ${base}/list \\\n  -H "Authorization: Bearer ${rawKey}" \\\n  -d '{"prefix":"${prefix}"}'`
  }
}

function ScopeList({ scopes }: { scopes: APIKeyScope[] }) {
  if (scopes.length === 0) {
    return <p className="text-xs text-gray-400 m-0">No scopes (key cannot be used).</p>
  }
  // Collapse groups covering all four base operations into one "all
  // actions" row — same grouping the form uses — so a key granted full
  // access to a prefix doesn't show as four near-identical lines.
  const grouped = collapseScopesForEdit(scopes)
  return (
    <ul className="list-none p-0 m-0 flex flex-col gap-1.5">
      {grouped.map((s) => {
        const meta = OPERATION_META[s.operation]
        const Icon = meta.icon
        return (
          <li key={`${s.operation}:${s.path_prefix}`} className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 font-medium rounded ${meta.badgeClass}`}>
              <Icon className="text-[13px]" /> {meta.label}
            </span>
            <span className="font-mono text-gray-500">{s.path_prefix || '/'}</span>
            <ScopeInfraBadges pathPrefix={s.path_prefix} />
          </li>
        )
      })}
    </ul>
  )
}

// ScopeInfraBadges resolves a persisted scope's text path_prefix back to a
// folder (best-effort — see resolvePathToFolder) so the key list can show the
// same server/tier badges as the creation form.
function ScopeInfraBadges({ pathPrefix }: { pathPrefix: string }) {
  const { data: folder } = useQuery({
    queryKey: ['folders', 'resolve-prefix', pathPrefix],
    queryFn: () => resolvePathToFolder(pathPrefix),
  })
  return <ApiKeyInfraBadges driveId={folder?.drive_id ?? null} />
}

// ScopeDraft carries an optional resolved Folder alongside the
// operation/path_prefix pair, purely so the form can show infra badges
// without a second round-trip lookup right after picking. operation is
// LocalOperation (not APIKeyScope's APIKeyOperation) so a row can hold the
// form-only 'all actions' value — see scopesToPayload/collapseScopesForEdit.
interface ScopeDraft {
  operation: LocalOperation
  path_prefix: string
  _folder?: Folder | null
}

// OperationPicker replaces a native <select> for choosing a scope's
// operation with a styled dropdown that matches the rest of the app's
// popovers (see DriveInfoButton in _auth.client/index.tsx for the same
// button+floating-panel+outside-click pattern) instead of the browser's
// unstyleable native option list. Includes the 'all actions' star option.
function OperationPicker({ value, onChange }: { value: LocalOperation; onChange: (op: LocalOperation) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const meta = OPERATION_META[value]
  const Icon = meta.icon

  useEffect(() => {
    if (!open) return
    function handleOutsideClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [open])

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 border border-gray-200 rounded-lg pl-2 pr-1.5 py-1.5 text-sm bg-white hover:border-gray-300 cursor-pointer"
      >
        <Icon className={value === 'all' ? 'text-amber-500' : 'text-gray-400'} />
        {meta.label}
        <MdKeyboardArrowDown className="text-gray-400" />
      </button>
      {open && (
        <div className="absolute z-20 top-full left-0 mt-1 w-40 border border-gray-200 rounded-lg bg-white shadow-lg overflow-hidden py-1">
          {OPERATION_PICKER_OPTIONS.map((op) => {
            const optMeta = OPERATION_META[op]
            const OptIcon = optMeta.icon
            const selected = op === value
            return (
              <button
                key={op}
                type="button"
                onClick={() => { onChange(op); setOpen(false) }}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left cursor-pointer bg-transparent border-0 ${
                  selected ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-50'
                } ${op === 'all' ? 'border-t border-gray-100 mt-1 pt-2' : ''}`}
              >
                <OptIcon className={op === 'all' ? 'text-amber-500' : 'text-gray-400'} />
                {optMeta.label}
                {selected && <MdCheck className="ml-auto text-blue-600" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function daysUntil(iso: string | null): number {
  if (!iso) return 0
  const ms = new Date(iso).getTime() - Date.now()
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)))
}

function KeyForm({
  initial, initialPrefix, onCreated, onUpdated, onCancel,
}: {
  initial: APIKey | null
  initialPrefix: string
  onCreated: (k: IssuedAPIKey) => void
  onUpdated: () => void
  onCancel: () => void
}) {
  const isEdit = initial !== null
  const [name, setName] = useState(initial?.name ?? '')
  const [ttlDays, setTtlDays] = useState<number>(initial ? daysUntil(initial.expires_at) : 0)
  const [rateLimit, setRateLimit] = useState<number>(initial?.rate_limit_per_min ?? API_KEY_DEFAULT_RATE_LIMIT_PER_MIN)
  const [scopes, setScopes] = useState<ScopeDraft[]>(
    initial?.scopes && initial.scopes.length > 0
      ? collapseScopesForEdit(initial.scopes)
      : [{ operation: 'read', path_prefix: initialPrefix }],
  )
  const [error, setError] = useState<string | null>(null)
  const { data: servers } = useMyServers()

  // Best-effort seed each scope's badge from its persisted prefix when
  // editing — folder ids aren't stored on the scope itself.
  useEffect(() => {
    if (!isEdit) return
    let cancelled = false
    scopes.forEach((s, i) => {
      if (s._folder !== undefined) return
      resolvePathToFolder(s.path_prefix).then((folder) => {
        if (cancelled) return
        setScopes((prev) => prev.map((p, j) => (j === i ? { ...p, _folder: folder } : p)))
      }).catch(() => {})
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit])

  const createMutation = useMutation({
    mutationFn: () => createAPIKey({
      name: name.trim(),
      scopes: scopesToPayload(scopes),
      ttl_days: ttlDays > 0 ? ttlDays : undefined,
      rate_limit_per_min: rateLimit,
    }),
    onSuccess: onCreated,
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed'),
  })

  const updateMutation = useMutation({
    mutationFn: () => updateAPIKey(initial!.id, {
      name: name.trim(),
      scopes: scopesToPayload(scopes),
      ttl_days: ttlDays > 0 ? ttlDays : undefined,
      rate_limit_per_min: rateLimit,
    }),
    onSuccess: onUpdated,
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed'),
  })

  const mutation = isEdit ? updateMutation : createMutation

  function updateScope(i: number, patch: Partial<ScopeDraft>) {
    setScopes((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (!name.trim() || scopes.length === 0) return; setError(null); mutation.mutate() }}
      className="mb-6 border border-gray-200 rounded-xl p-4 bg-white flex flex-col gap-4"
    >
      <h2 className="text-sm font-semibold text-gray-900 m-0">{isEdit ? `Edit “${initial!.name}”` : 'New API key'}</h2>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Name</span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. backup-script (prod)"
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </label>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Scopes</label>
        <div className="flex flex-col gap-3">
          {scopes.map((s, i) => {
            const driveId = s._folder !== undefined ? (s._folder?.drive_id ?? null) : undefined
            return (
              <div key={i} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <OperationPicker
                    value={s.operation}
                    onChange={(operation) => updateScope(i, { operation })}
                  />
                  <FolderPrefixPicker
                    value={s.path_prefix}
                    onSelect={(prefix, folder) => updateScope(i, { path_prefix: prefix, _folder: folder })}
                  />
                  {scopes.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setScopes((prev) => prev.filter((_, j) => j !== i))}
                      className="text-red-400 hover:text-red-600 bg-transparent border-0 p-1 cursor-pointer shrink-0"
                      title="Remove scope"
                    >
                      <MdDelete />
                    </button>
                  )}
                </div>
                {servers && servers.length > 0 && (
                  <div className="pl-1">
                    <ApiKeyInfraBadges driveId={driveId ?? null} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => setScopes((prev) => [...prev, { operation: 'read', path_prefix: '' }])}
          className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline bg-transparent border-0 p-0 cursor-pointer"
        >
          <MdAdd /> Add scope
        </button>
      </div>
      <label className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-500 shrink-0">Expires in (days{isEdit ? ' from today' : ''})</span>
        <input
          type="number"
          min={0}
          max={API_KEY_MAX_TTL_DAYS}
          value={ttlDays}
          onChange={(e) => setTtlDays(Math.min(API_KEY_MAX_TTL_DAYS, Math.max(0, Number(e.target.value))))}
          className="w-24 border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
        />
        <span className="text-xs text-gray-400">0 = no expiry, max {API_KEY_MAX_TTL_DAYS} (10 years)</span>
      </label>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-gray-500">Rate limit</span>
          <span className="text-xs font-mono text-gray-700">{rateLimit} req/min</span>
        </div>
        <input
          type="range"
          min={10}
          max={API_KEY_MAX_RATE_LIMIT_PER_MIN}
          step={10}
          value={rateLimit}
          onChange={(e) => setRateLimit(Number(e.target.value))}
          className="w-full accent-blue-600 cursor-pointer"
        />
        <span className="text-[11px] text-gray-400">
          Requests/minute this key may make against the SFS API. Global max: {API_KEY_MAX_RATE_LIMIT_PER_MIN}/min.
        </span>
      </div>
      {error && <p className="text-xs text-red-500 m-0">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg border border-gray-200 cursor-pointer transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={mutation.isPending || !name.trim() || scopes.length === 0}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-40 cursor-pointer transition-colors"
        >
          {mutation.isPending ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save changes' : 'Create key')}
        </button>
      </div>
    </form>
  )
}

const GUIDE_STEPS: { title: string; body: ReactNode }[] = [
  {
    title: 'What are API keys for?',
    body: (
      <>
        <p className="m-0 mb-3">
          API keys give scripts, backup tools, or your own apps programmatic, S3-style access to
          your Apollo SFS storage — the same encrypted files and quota you see here, just reachable
          without a browser.
        </p>
        <p className="m-0">
          Each key is scoped: you choose exactly which operations (
          <code className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">read</code>,{' '}
          <code className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">write</code>,{' '}
          <code className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">list</code>,{' '}
          <code className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">delete</code>) it can
          perform and on which folder — from read-only access to a single subfolder up to full
          control of your whole account.
        </p>
      </>
    ),
  },
  {
    title: 'Create a key',
    body: (
      <>
        <p className="m-0 mb-3">
          Click <span className="font-medium">New key</span>, give it a name, and add one or more
          scopes — an operation plus a path prefix. Browse into a folder to scope a key to it, or
          leave it at the root to cover your whole bucket. You can also set an expiry and a
          requests-per-minute limit.
        </p>
        <p className="m-0 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-amber-800">
          The full key is shown exactly once, right after creation. Copy it somewhere safe — the
          server only ever stores its hash.
        </p>
      </>
    ),
  },
  {
    title: 'Use your key',
    body: (
      <>
        <p className="m-0 mb-3">
          Send it as a bearer token on every request to{' '}
          <code className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">/api/v1/sfs/buckets/me/…</code>:
        </p>
        <pre className="m-0 mb-3 bg-gray-900 text-gray-100 text-xs rounded-lg p-3 overflow-x-auto">
{`curl -X POST ${APP_DOMAIN}/api/v1/sfs/buckets/me/list \\
  -H "Authorization: Bearer sfs_<prefix>_<secret>" \\
  -d '{"prefix":"photos"}'`}
        </pre>
        <p className="m-0">
          Endpoints cover upload, download, delete, list, and move — each request is checked
          against the scopes on the key you send.
        </p>
      </>
    ),
  },
  {
    title: 'Manage & revoke',
    body: (
      <>
        <p className="m-0 mb-3">
          Every key you&rsquo;ve issued is listed on this page with its scopes and last-used date.
          Edit a key any time to change its scopes, expiry, or rate limit — the secret keeps
          working under the new rules. Revoke a key instead if it&rsquo;s no longer needed or you
          think it&rsquo;s been exposed — revocation takes effect immediately.
        </p>
        <p className="m-0">
          Lost the secret? There&rsquo;s no way to recover it — revoke the old key and issue a new
          one instead. You can reopen this guide anytime with the <MdInfoOutline className="inline align-text-bottom" /> button above.
        </p>
      </>
    ),
  },
]

function ApiKeyGuideModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0)
  const isLastStep = step === GUIDE_STEPS.length - 1

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-full max-w-lg flex flex-col max-h-[85vh]"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h2 className="text-base font-semibold text-gray-900 m-0">
            {GUIDE_STEPS[step].title}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors cursor-pointer bg-transparent border-0 p-1"
            aria-label="Close"
          >
            <MdClose className="text-xl" />
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-5 text-sm text-gray-700 leading-relaxed">
          <p className="text-xs text-gray-400 m-0 mb-3">
            Step {step + 1} of {GUIDE_STEPS.length}
          </p>
          {GUIDE_STEPS[step].body}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 shrink-0">
          <div className="flex items-center gap-1.5">
            {GUIDE_STEPS.map((_, i) => (
              <span
                key={i}
                className={`w-1.5 h-1.5 rounded-full ${i === step ? 'bg-blue-600' : 'bg-gray-200'}`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg border border-gray-200 cursor-pointer transition-colors"
              >
                Back
              </button>
            )}
            <button
              onClick={() => (isLastStep ? onClose() : setStep((s) => s + 1))}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
            >
              {isLastStep ? 'Got it' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
