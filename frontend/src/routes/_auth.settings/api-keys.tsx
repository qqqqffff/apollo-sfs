import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { MdAdd, MdClose, MdContentCopy, MdCheck, MdDelete, MdInfoOutline, MdKey, MdWarning } from 'react-icons/md'
import { createAPIKey, listAPIKeys, revokeAPIKey } from '../../api/apiKeys'
import { meQueryOptions } from '../../api/me'
import type { APIKeyOperation, APIKeyScope, IssuedAPIKey } from '../../types/api'

const OPS: APIKeyOperation[] = ['read', 'list', 'write', 'delete']

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

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gray-900 m-0">API Keys</h1>
        {!creating && (
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
          scopes — an operation plus a path prefix. Leave the prefix empty to cover your whole
          bucket. You can also set it to expire after a number of days.
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
{`curl -X POST https://<your-domain>/api/v1/sfs/buckets/me/list \\
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
          Revoke a key any time if it&rsquo;s no longer needed or you think it&rsquo;s been
          exposed — revocation takes effect immediately.
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
