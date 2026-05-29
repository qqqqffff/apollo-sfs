import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { MdAdd, MdContentCopy, MdCheck, MdDelete, MdKey, MdWarning } from 'react-icons/md'
import { createAPIKey, listAPIKeys, revokeAPIKey } from '../../api/apiKeys'
import { meQueryOptions } from '../../api/me'
import type { APIKeyOperation, APIKeyScope, IssuedAPIKey } from '../../types/api'

const OPS: APIKeyOperation[] = ['read', 'list', 'write', 'delete']

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
  const [issued, setIssued] = useState<IssuedAPIKey | null>(null)
  const [copiedIssued, setCopiedIssued] = useState(false)

  useEffect(() => {
    if (search.prefix !== undefined) setCreating(true)
  }, [search.prefix])

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

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gray-900 m-0">API Keys</h1>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
          >
            <MdAdd /> New key
          </button>
        )}
      </div>

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

      {creating && (
        <CreateKeyForm
          initialPrefix={search.prefix ?? ''}
          onCreated={(k) => {
            setIssued(k)
            setCreating(false)
            queryClient.invalidateQueries({ queryKey: ['api-keys'] })
            // Strip ?prefix= so a refresh doesn't reopen the form.
            navigate({ to: '/settings/api-keys' as never, search: {} as never, replace: true })
          }}
          onCancel={() => {
            setCreating(false)
            navigate({ to: '/settings/api-keys' as never, search: {} as never, replace: true })
          }}
        />
      )}

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading keys…</p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-gray-400">You don&rsquo;t have any API keys yet.</p>
      ) : (
        <ul className="list-none p-0 m-0 flex flex-col gap-3">
          {keys.map((k) => (
            <li key={k.id} className="border border-gray-200 rounded-xl p-4 bg-white">
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
                    {k.last_used_at && ` • last used ${new Date(k.last_used_at).toLocaleDateString()}`}
                    {k.expires_at && ` • expires ${new Date(k.expires_at).toLocaleDateString()}`}
                  </div>
                  <ScopeList scopes={k.scopes ?? []} />
                </div>
                {!k.revoked_at && (
                  <button
                    onClick={() => { if (confirm(`Revoke ${k.name}? This cannot be undone.`)) revoke.mutate(k.id) }}
                    title="Revoke key"
                    className="text-red-500 hover:text-red-700 cursor-pointer bg-transparent border-0 p-1 transition-colors"
                  >
                    <MdDelete className="text-lg" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
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
      <button
        onClick={onDismiss}
        className="text-xs text-gray-500 hover:text-gray-700 bg-transparent border-0 p-0 cursor-pointer"
      >
        I&rsquo;ve saved it. Dismiss.
      </button>
    </div>
  )
}

function ScopeList({ scopes }: { scopes: APIKeyScope[] }) {
  if (scopes.length === 0) {
    return <p className="text-xs text-gray-400 m-0">No scopes (key cannot be used).</p>
  }
  return (
    <ul className="list-none p-0 m-0 flex flex-wrap gap-1.5">
      {scopes.map((s) => (
        <li key={s.id ?? `${s.operation}:${s.path_prefix}`} className="inline-flex items-center gap-1 text-xs">
          <span className="px-1.5 py-0.5 font-mono uppercase rounded bg-blue-100 text-blue-700">{s.operation}</span>
          <span className="font-mono text-gray-500">{s.path_prefix || '/'}</span>
        </li>
      ))}
    </ul>
  )
}

function CreateKeyForm({
  initialPrefix, onCreated, onCancel,
}: { initialPrefix: string; onCreated: (k: IssuedAPIKey) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [ttlDays, setTtlDays] = useState<number>(0)
  const [scopes, setScopes] = useState<APIKeyScope[]>([
    { operation: 'read', path_prefix: initialPrefix },
  ])
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => createAPIKey({
      name: name.trim(),
      scopes,
      ttl_days: ttlDays > 0 ? ttlDays : undefined,
    }),
    onSuccess: onCreated,
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed'),
  })

  function updateScope(i: number, patch: Partial<APIKeyScope>) {
    setScopes((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (!name.trim() || scopes.length === 0) return; setError(null); mutation.mutate() }}
      className="mb-6 border border-gray-200 rounded-xl p-4 bg-white flex flex-col gap-4"
    >
      <h2 className="text-sm font-semibold text-gray-900 m-0">New API key</h2>
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
        <div className="flex flex-col gap-2">
          {scopes.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                value={s.operation}
                onChange={(e) => updateScope(i, { operation: e.target.value as APIKeyOperation })}
                className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white"
              >
                {OPS.map((op) => <option key={op} value={op}>{op}</option>)}
              </select>
              <input
                value={s.path_prefix}
                onChange={(e) => updateScope(i, { path_prefix: e.target.value })}
                placeholder="path prefix (empty = whole bucket)"
                className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              {scopes.length > 1 && (
                <button
                  type="button"
                  onClick={() => setScopes((prev) => prev.filter((_, j) => j !== i))}
                  className="text-red-400 hover:text-red-600 bg-transparent border-0 p-1 cursor-pointer"
                  title="Remove scope"
                >
                  <MdDelete />
                </button>
              )}
            </div>
          ))}
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
        <span className="text-xs font-medium text-gray-500 shrink-0">Expires in (days)</span>
        <input
          type="number"
          min={0}
          value={ttlDays}
          onChange={(e) => setTtlDays(Number(e.target.value))}
          className="w-24 border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
        />
        <span className="text-xs text-gray-400">0 = no expiry</span>
      </label>
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
          {mutation.isPending ? 'Creating…' : 'Create key'}
        </button>
      </div>
    </form>
  )
}
