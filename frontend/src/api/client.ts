const BASE = '/api/v1'

function dispatchSessionExpired() {
  window.dispatchEvent(new CustomEvent('apollo:session-expired'))
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    ...init,
  })

  if (!res.ok) {
    if (res.status === 401) dispatchSessionExpired()
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    throw new ApiError(res.status, (body.error as string | undefined) ?? res.statusText, body)
  }

  // 204 No Content
  if (res.status === 204) return undefined as T

  return res.json() as Promise<T>
}

export function get<T>(path: string) {
  return request<T>(path)
}

export function post<T>(path: string, body?: unknown) {
  return request<T>(path, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

export function patch<T>(path: string, body: unknown) {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
}

export function del<T>(path: string) {
  return request<T>(path, { method: 'DELETE' })
}

export async function upload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    credentials: 'include',
    body: form,
    // Do not set Content-Type — browser sets it with the multipart boundary.
  })

  if (!res.ok) {
    if (res.status === 401) dispatchSessionExpired()
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new ApiError(res.status, body.error ?? res.statusText)
  }

  return res.json() as Promise<T>
}

// How long the upload may stall (no new bytes sent) before it is aborted.
// This timer resets on every XHR progress event that advances bytes, so a slow
// but active upload will never be killed. 10 minutes covers TCP retransmits,
// congestion backoff, and server-side flow control on the worst real connections.
const STALL_TIMEOUT_MS = 600_000

// XHR-based upload that fires onProgress(loaded, total) as bytes are sent.
// Automatically aborts and rejects if no bytes are transferred for STALL_TIMEOUT_MS.
export function uploadWithProgress<T>(
  path: string,
  form: FormData,
  onProgress: (loaded: number, total: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let lastLoaded = 0
    let stallTimer: ReturnType<typeof setTimeout> | null = null
    // Prevents the abort event handler from double-rejecting after a stall abort.
    let stalledOut = false

    function clearStall() {
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null }
    }

    function resetStall() {
      clearStall()
      stallTimer = setTimeout(() => {
        stalledOut = true
        xhr.abort()
        reject(new ApiError(0, 'Upload stalled — no data transferred for 10 minutes'))
      }, STALL_TIMEOUT_MS)
    }

    // Start the stall timer as soon as the browser begins sending the body.
    xhr.upload.addEventListener('loadstart', () => resetStall())

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        // Only reset the timer when bytes actually advance.
        if (e.loaded > lastLoaded) {
          lastLoaded = e.loaded
          resetStall()
        }
        onProgress(e.loaded, e.total)
      }
    })

    // Upload body fully sent — server is now processing. No stall risk here.
    xhr.upload.addEventListener('load', () => clearStall())

    xhr.addEventListener('load', () => {
      clearStall()
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T)
        } catch {
          reject(new ApiError(xhr.status, 'Invalid response'))
        }
      } else {
        if (xhr.status === 401) dispatchSessionExpired()
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string }
          reject(new ApiError(xhr.status, body.error ?? xhr.statusText))
        } catch {
          reject(new ApiError(xhr.status, xhr.statusText))
        }
      }
    })

    xhr.addEventListener('error', () => { clearStall(); reject(new ApiError(0, 'Network error')) })
    xhr.addEventListener('abort', () => { clearStall(); if (!stalledOut) reject(new ApiError(0, 'Cancelled')) })

    xhr.open('POST', BASE + path)
    xhr.withCredentials = true
    xhr.send(form)
  })
}
