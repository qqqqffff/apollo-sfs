import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MdCheckCircle, MdClose, MdErrorOutline, MdMergeType, MdWarningAmber } from 'react-icons/md'
import { getDuplicateUsers, reconcileDuplicateUsers } from '../api/admin'
import type { DuplicateGroup, DuplicateOutcome, DuplicateReconcileRun } from '../types/api'
import { formatBytes } from '../utils/auditFormat'

const QUERY_KEY = ['admin', 'users', 'duplicates'] as const

// DuplicateAccountsBanner sits at the top of the admin Users page. It stays
// out of the way when there is nothing to reconcile, and otherwise offers a
// review of each group of rows that are the same person before merging them.
export function DuplicateAccountsBanner() {
  const [open, setOpen] = useState(false)
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getDuplicateUsers,
    // Poll only while a run is going; the merge re-encrypts files and can take a while.
    refetchInterval: (q) => (q.state.data?.run?.running ? 2000 : false),
  })
  const groups = data?.groups ?? []
  const run = data?.run ?? null
  const actionable = groups.filter((g) => !g.blocker)

  if (!groups.length && !run?.running && !open) return null

  return (
    <>
      {(groups.length > 0 || run?.running) && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <MdWarningAmber className="text-xl text-amber-600 shrink-0" />
          <p className="m-0 flex-1 text-sm text-amber-900">
            {run?.running
              ? 'Reconciling duplicate accounts…'
              : `${groups.length} account ${groups.length === 1 ? 'issue' : 'issues'} found — ` +
                `${groups.filter((g) => g.action === 'merge').length} duplicated, ` +
                `${groups.filter((g) => g.action === 'normalize').length} stored with capital letters.`}
          </p>
          <button
            onClick={() => setOpen(true)}
            className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 border-0 cursor-pointer"
          >
            Review
          </button>
        </div>
      )}
      {open && (
        <DuplicateAccountsModal groups={groups} actionable={actionable.length} run={run} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

function DuplicateAccountsModal({ groups, actionable, run, onClose }: {
  groups: DuplicateGroup[]
  actionable: number
  run: DuplicateReconcileRun | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const reconcile = useMutation({
    mutationFn: reconcileDuplicateUsers,
    onSuccess: () => {
      setError(null)
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    },
    onError: (e: Error) => setError(e.message || 'Could not start reconciliation'),
  })
  // Once a run finishes, the Users table underneath has changed too.
  const finishedAt = run && !run.running ? run.finished_at : undefined
  useEffect(() => {
    if (finishedAt) queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
  }, [finishedAt, queryClient])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-3xl mx-4 flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <MdMergeType className="text-lg text-indigo-600" />
            <h3 className="text-sm font-semibold text-gray-800 m-0">Duplicate accounts</h3>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0">
            <MdClose className="text-lg" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4 flex flex-col gap-4">
          <p className="m-0 text-xs text-gray-600">
            Each group below is one person. Reconciling keeps the row marked <strong>keep</strong>,
            moves everything the others own onto it (files stay put; any encrypted under the
            other row&apos;s key are re-encrypted), and records the merge in the user&apos;s audit log.
            Removed rows are snapshotted so a merge can be undone by hand.
          </p>

          {run && <RunReport run={run} />}

          {groups.length === 0 && !run?.running && (
            <p className="text-sm text-gray-500 text-center py-4 m-0">No duplicate accounts remain.</p>
          )}
          {groups.map((g) => <GroupCard key={g.accounts.map((a) => a.username).join('|')} group={g} />)}
          {error && <p className="m-0 text-xs text-red-600">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-100">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-gray-600 bg-transparent border border-gray-200 cursor-pointer hover:bg-gray-50">
            Close
          </button>
          <button
            onClick={() => reconcile.mutate()}
            disabled={actionable === 0 || reconcile.isPending || !!run?.running}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 border-0 cursor-pointer hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {run?.running ? 'Reconciling…' : `Reconcile ${actionable} ${actionable === 1 ? 'group' : 'groups'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function GroupCard({ group }: { group: DuplicateGroup }) {
  return (
    <div className={`rounded-lg border p-3 ${group.blocker ? 'border-gray-200 bg-gray-50' : 'border-indigo-100'}`}>
      <p className="m-0 mb-2 text-xs text-gray-700">
        {group.action === 'merge' ? 'Merge into ' : 'Normalize to '}
        <strong>{group.username}</strong> · {group.email}
        {group.action === 'merge' && <> · quota {formatBytes(group.quota_bytes)}</>}
      </p>
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-left text-gray-400">
            <th className="font-medium pb-1" />
            <th className="font-medium pb-1">Username</th>
            <th className="font-medium pb-1">Email</th>
            <th className="font-medium pb-1">Role</th>
            <th className="font-medium pb-1">Quota / used</th>
            <th className="font-medium pb-1">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {group.accounts.map((a) => (
            <tr key={a.username} className="text-gray-700">
              <td className="pr-2 py-0.5">
                {a.keep
                  ? <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">keep</span>
                  : <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">merge</span>}
              </td>
              <td className="pr-2 py-0.5 font-medium">{a.username}</td>
              <td className="pr-2 py-0.5">{a.email}</td>
              <td className="pr-2 py-0.5">
                {a.is_admin ? 'admin' : a.is_premium ? 'premium' : 'user'}
                {a.premium_expires_at && <span className="text-gray-400"> (trial to {new Date(a.premium_expires_at).toLocaleDateString()})</span>}
              </td>
              <td className="pr-2 py-0.5 whitespace-nowrap">
                {formatBytes(a.storage_quota_bytes)} / {formatBytes(a.storage_used_bytes)}
                {a.allocations === 0 && <span className="text-gray-400"> · no drive</span>}
              </td>
              <td className="py-0.5 whitespace-nowrap">{a.last_seen_at ? new Date(a.last_seen_at).toLocaleString() : 'never'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {group.blocker && (
        <p className="m-0 mt-2 flex items-start gap-1 text-xs text-amber-700">
          <MdWarningAmber className="mt-0.5 shrink-0" /> Needs a person: {group.blocker}
        </p>
      )}
    </div>
  )
}

function RunReport({ run }: { run: DuplicateReconcileRun }) {
  const byStatus = (s: DuplicateOutcome['status']) => run.outcomes.filter((o) => o.status === s)
  const failed = byStatus('failed')
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
      <p className="m-0 font-medium">
        {run.running ? 'Running…' : `Last run by ${run.started_by}, ${new Date(run.finished_at ?? run.started_at).toLocaleString()}`}
      </p>
      <p className="m-0 mt-1">
        {byStatus('merged').length} merged · {byStatus('normalized').length} normalized ·{' '}
        {byStatus('skipped').length} skipped · {failed.length} failed
        {run.indexes_created && <> · <MdCheckCircle className="inline text-green-600 align-[-2px]" /> duplicates can no longer be created</>}
      </p>
      {run.error && <p className="m-0 mt-1 text-red-600">{run.error}</p>}
      {failed.map((o) => (
        <p key={o.username} className="m-0 mt-1 flex items-start gap-1 text-red-600">
          <MdErrorOutline className="mt-0.5 shrink-0" /> {o.accounts.map((a) => a.username).join(', ')}: {o.error}
        </p>
      ))}
      {run.outcomes.filter((o) => o.rekey && o.rekey.rekeyed > 0).map((o) => (
        <p key={`rk-${o.username}`} className="m-0 mt-1 text-gray-500">
          {o.username}: re-encrypted {o.rekey!.rekeyed} of {o.rekey!.checked} objects ({formatBytes(o.rekey!.rekey_bytes)})
          {o.rekey!.unreadable?.length ? `, ${o.rekey!.unreadable.length} unreadable under any key (left as is)` : ''}
        </p>
      ))}
    </div>
  )
}
