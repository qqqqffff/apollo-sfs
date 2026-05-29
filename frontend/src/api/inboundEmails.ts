import { del, get, patch } from './client'
import type { PageResult } from '../types/api'
import type { EmailDetail, EmailMeta, EmailWorker } from '../types/inboundEmail'

// ── Inbound emails (admin) ───────────────────────────────────────────────────

export function listEmailWorkers() {
  return get<{ workers: EmailWorker[] }>('/admin/emails/workers')
}

export function listEmails(worker?: string, cursor?: string, limit?: number) {
  const params = new URLSearchParams()
  if (worker) params.set('worker', worker)
  if (cursor) params.set('cursor', cursor)
  if (limit) params.set('limit', String(limit))
  const qs = params.size ? `?${params}` : ''
  return get<PageResult<EmailMeta>>(`/admin/emails${qs}`)
}

export function getEmail(id: string) {
  return get<EmailDetail>(`/admin/emails/${id}`)
}

export function markEmailRead(id: string) {
  return patch<{ message: string }>(`/admin/emails/${id}/read`, {})
}

export function deleteEmail(id: string) {
  return del<{ message: string }>(`/admin/emails/${id}`)
}

// ── Query options ────────────────────────────────────────────────────────────

export const emailWorkersQueryOptions = {
  queryKey: ['admin', 'emails', 'workers'] as const,
  queryFn: listEmailWorkers,
  refetchInterval: 30_000,
}

export function emailsInfiniteQueryOptions(worker?: string) {
  return {
    queryKey: ['admin', 'emails', 'list', worker ?? 'all'] as const,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      listEmails(worker, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: PageResult<EmailMeta>) =>
      lastPage.next_token || undefined,
  }
}
