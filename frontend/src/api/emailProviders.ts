// Provider-side integration for the email backup feature. Mirrors the Google
// Drive/Photos backup pattern: all provider OAuth and message fetching happens
// in the browser — the Apollo SFS backend never sees provider tokens, it only
// receives the already-fetched messages to encrypt and store.
//
// Supported providers:
//   - Gmail            (Google Identity Services token + Gmail REST API)
//   - Microsoft/Outlook (Microsoft identity platform PKCE popup + Graph API)

import { getGoogleUserEmail, requestGoogleAccessTokenForScopes } from './googleBackup'

export type EmailProvider = 'gmail' | 'microsoft'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GRAPH_API = 'https://graph.microsoft.com/v1.0'

// gmail.modify (rather than gmail.readonly) so the optional
// "delete after backup" setting can move backed-up mail to the Gmail trash
// without a second consent round-trip mid-backup.
const GMAIL_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
].join(' ')

const MS_AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0'
const MS_SCOPES = [
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Mail.ReadWrite',
].join(' ')
// Registered as a "Single-page application" redirect URI in the Azure app —
// the static page posts the auth code back to the opener (see public/ms-oauth.html).
const MS_REDIRECT_PATH = '/ms-oauth.html'

// Azure AD application (client) id for the Microsoft sign-in popup. Build-time
// configured; the Microsoft option reports a clear error when unset.
const MS_CLIENT_ID: string = (import.meta.env.VITE_MS_CLIENT_ID as string | undefined) ?? ''

// Emails are fetched a page at a time — this is both the size of one raw
// paginated round-trip and the unit progress is reported in.
const PAGE_SIZE = 200

// Hard ceiling regardless of the user's retrieval criteria, so a distant
// "since" date or a large size target can't page through an entire mailbox
// in one sitting. listProviderMessages reports { truncated: true } if hit.
const SAFETY_CAP_EMAILS = 10_000

// EmailRetrievalCriteria is chosen by the user (EmailRetrievalCriteriaModal)
// before sign-in and decides when listProviderMessages stops paging.
export type EmailRetrievalCriteria =
  | { mode: 'amount'; amount: number }
  // sinceDate is a yyyy-mm-dd string; retrieves messages received on/after it.
  | { mode: 'date'; sinceDate: string }
  // Gmail-only — Graph doesn't report a message size (see listOutlookMessages).
  | { mode: 'size'; maxBytes: number }

export interface ListMessagesResult {
  items: ProviderEmailItem[]
  // True if SAFETY_CAP_EMAILS was hit before the criteria was satisfied.
  truncated: boolean
  // True when paging stopped early because the caller asked it to.
  stopped: boolean
}

// ListMessagesOptions lets the picker render while the mailbox is still being
// paged: onPage delivers every page as it lands (accumulated and already
// trimmed to the criteria, so the table never shows rows the run would drop),
// and shouldStop ends paging early — the "Stop fetching" button — keeping
// whatever has arrived.
export interface ListMessagesOptions {
  onPage?: (items: ProviderEmailItem[], progress: FetchProgress) => void
  shouldStop?: () => boolean
}

// FetchProgress describes how far the paged fetch has got. `fraction` is null
// when the criteria gives nothing to measure against.
export interface FetchProgress {
  fetched: number
  fraction: number | null
}

// fetchProgressFor estimates completion against the chosen criteria: a count
// and a byte total measure directly; a "since" date measures how far the
// oldest message fetched has travelled back towards the cutoff.
export function fetchProgressFor(
  criteria: EmailRetrievalCriteria,
  items: ProviderEmailItem[],
): FetchProgress {
  const fetched = items.length
  const clamp = (v: number) => Math.max(0, Math.min(1, v))

  switch (criteria.mode) {
    case 'amount':
      return { fetched, fraction: criteria.amount > 0 ? clamp(fetched / criteria.amount) : null }
    case 'size': {
      const bytes = items.reduce((sum, i) => sum + i.sizeEstimate, 0)
      return { fetched, fraction: criteria.maxBytes > 0 ? clamp(bytes / criteria.maxBytes) : null }
    }
    case 'date': {
      const last = items[items.length - 1]
      const sinceTs = new Date(criteria.sinceDate + 'T00:00:00').getTime()
      const now = Date.now()
      if (!last || Number.isNaN(sinceTs) || now <= sinceTs) return { fetched, fraction: null }
      const lastTs = new Date(last.date).getTime()
      if (Number.isNaN(lastTs)) return { fetched, fraction: null }
      return { fetched, fraction: clamp((now - lastTs) / (now - sinceTs)) }
    }
  }
}

function criteriaSatisfied(criteria: EmailRetrievalCriteria, items: ProviderEmailItem[]): boolean {
  switch (criteria.mode) {
    case 'amount':
      return items.length >= criteria.amount
    case 'date': {
      // Both providers list newest-first, so once the oldest fetched item
      // crosses the cutoff, every later page would only be older still.
      const last = items[items.length - 1]
      if (!last) return false
      const lastTs = new Date(last.date).getTime()
      const sinceTs = new Date(criteria.sinceDate + 'T00:00:00').getTime()
      return !Number.isNaN(lastTs) && lastTs < sinceTs
    }
    case 'size':
      return items.reduce((sum, i) => sum + i.sizeEstimate, 0) >= criteria.maxBytes
  }
}

// Trims the accumulated pages down to exactly what the criteria asked for
// (amount/date can overshoot by up to one page; size is left as an estimate
// since trimming mid-page would drop an otherwise-matching email).
function finalizeByCriteria(criteria: EmailRetrievalCriteria, items: ProviderEmailItem[]): ProviderEmailItem[] {
  if (criteria.mode === 'amount') return items.slice(0, criteria.amount)
  if (criteria.mode === 'date') {
    const sinceTs = new Date(criteria.sinceDate + 'T00:00:00').getTime()
    return items.filter((i) => {
      const ts = new Date(i.date).getTime()
      return Number.isNaN(ts) || ts >= sinceTs
    })
  }
  return items
}

// ── Public types ──────────────────────────────────────────────────────────────

// ProviderEmailItem is the provider-agnostic metadata row shown in the picker.
export interface ProviderEmailItem {
  id: string
  provider: EmailProvider
  from: string          // full header value, e.g. `Jane Doe <jane@x.com>`
  fromAddr: string      // bare lower-cased address, used by the sender filter
  to: string
  subject: string
  snippet: string
  date: string          // ISO timestamp
  starred: boolean      // Gmail star / Outlook flag
  unread: boolean
  hasAttachments: boolean
  sizeEstimate: number  // bytes; 0 when the provider doesn't report a size
}

// StoredEmailPayload mirrors the Go models.StoredEmail JSON shape — the full
// message document the backend encrypts and stores.
export interface StoredEmailPayload {
  message_id: string
  from: string
  to: string
  subject: string
  date: string
  text: string
  html: string
  headers: string
  attachments: {
    filename: string
    content_type: string
    size: number
    content_base64?: string
  }[]
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function providerFetch(url: string, accessToken: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status}: ${body}`)
  }
  if (res.status === 204) return null
  return res.json().catch(() => null)
}

export function bareAddress(header: string): string {
  const m = header.match(/<([^>]+)>/)
  return (m ? m[1] : header).trim().toLowerCase()
}

// Decodes Gmail's base64url variant into a standard base64 string.
function base64UrlToBase64(data: string): string {
  let out = data.replace(/-/g, '+').replace(/_/g, '/')
  while (out.length % 4 !== 0) out += '='
  return out
}

// Decodes base64url data into a UTF-8 string.
function decodeBase64UrlText(data: string): string {
  const binary = atob(base64UrlToBase64(data))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

export async function requestGmailAccessToken(): Promise<string> {
  return requestGoogleAccessTokenForScopes(GMAIL_SCOPES)
}

export async function getGmailUserEmail(accessToken: string): Promise<string | null> {
  return getGoogleUserEmail(accessToken)
}

interface GmailHeader { name: string; value: string }

function gmailHeader(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

// fetchGmailIdPage gathers up to PAGE_SIZE message ids starting from
// pageToken (two 100-id list calls, Gmail's per-request max).
async function fetchGmailIdPage(
  accessToken: string,
  pageToken: string | undefined,
): Promise<{ ids: string[]; nextPageToken?: string }> {
  const ids: string[] = []
  let token = pageToken
  while (ids.length < PAGE_SIZE) {
    let url = `${GMAIL_API}/messages?maxResults=100&includeSpamTrash=false`
    if (token) url += `&pageToken=${encodeURIComponent(token)}`
    const data = await providerFetch(url, accessToken)
    for (const m of data.messages ?? []) ids.push(m.id)
    token = data.nextPageToken
    if (!token) break
  }
  return { ids, nextPageToken: token }
}

// fetchGmailMetadata resolves ids to picker rows in small parallel batches.
async function fetchGmailMetadata(accessToken: string, ids: string[]): Promise<ProviderEmailItem[]> {
  const items: ProviderEmailItem[] = []
  const BATCH = 10
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = await Promise.all(
      ids.slice(i, i + BATCH).map(async (id) => {
        const m = await providerFetch(
          `${GMAIL_API}/messages/${id}?format=metadata` +
          `&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
          accessToken,
        )
        const headers: GmailHeader[] = m.payload?.headers ?? []
        const labels: string[] = m.labelIds ?? []
        const from = gmailHeader(headers, 'From')
        return {
          id: m.id,
          provider: 'gmail' as const,
          from,
          fromAddr: bareAddress(from),
          to: gmailHeader(headers, 'To'),
          subject: gmailHeader(headers, 'Subject'),
          snippet: m.snippet ?? '',
          date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : '',
          starred: labels.includes('STARRED'),
          unread: labels.includes('UNREAD'),
          // format=metadata doesn't include the part tree; attachments are
          // detected precisely during the full download.
          hasAttachments: false,
          sizeEstimate: Number(m.sizeEstimate ?? 0),
        }
      }),
    )
    items.push(...batch)
  }
  return items
}

// listGmailMessages pages 200 messages at a time — newest first — until
// criteria is satisfied, the mailbox is exhausted, SAFETY_CAP_EMAILS hits, or
// the caller stops it. Every page is handed to opts.onPage as it lands so the
// picker can fill in while the rest is still downloading.
export async function listGmailMessages(
  accessToken: string,
  criteria: EmailRetrievalCriteria,
  opts: ListMessagesOptions = {},
): Promise<ListMessagesResult> {
  const items: ProviderEmailItem[] = []
  let pageToken: string | undefined
  let truncated = false
  let stopped = false

  while (true) {
    if (opts.shouldStop?.()) { stopped = true; break }
    const { ids, nextPageToken } = await fetchGmailIdPage(accessToken, pageToken)
    if (ids.length === 0) break
    items.push(...await fetchGmailMetadata(accessToken, ids))
    emitPage(criteria, items, opts)

    if (items.length >= SAFETY_CAP_EMAILS) { truncated = true; break }
    if (criteriaSatisfied(criteria, items)) break
    if (!nextPageToken) break
    if (opts.shouldStop?.()) { stopped = true; break }
    pageToken = nextPageToken
  }

  return { items: finalizeByCriteria(criteria, items), truncated, stopped }
}

// emitPage hands the caller everything fetched so far, trimmed exactly the way
// the final result will be, plus a progress estimate.
function emitPage(
  criteria: EmailRetrievalCriteria,
  items: ProviderEmailItem[],
  opts: ListMessagesOptions,
): void {
  if (!opts.onPage) return
  const trimmed = finalizeByCriteria(criteria, items)
  opts.onPage(trimmed, fetchProgressFor(criteria, trimmed))
}

interface GmailPart {
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: GmailPart[]
}

// downloadGmailMessage fetches the full message and flattens the MIME tree
// into the StoredEmailPayload document (text + html bodies, attachments inline
// as base64).
export async function downloadGmailMessage(accessToken: string, id: string): Promise<StoredEmailPayload> {
  const m = await providerFetch(`${GMAIL_API}/messages/${id}?format=full`, accessToken)
  const headers: GmailHeader[] = m.payload?.headers ?? []

  const out: StoredEmailPayload = {
    message_id: gmailHeader(headers, 'Message-ID') || gmailHeader(headers, 'Message-Id') || m.id,
    from: gmailHeader(headers, 'From'),
    to: gmailHeader(headers, 'To'),
    subject: gmailHeader(headers, 'Subject'),
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date().toISOString(),
    text: '',
    html: '',
    headers: headers.map((h) => `${h.name}: ${h.value}`).join('\n'),
    attachments: [],
  }

  async function walk(part: GmailPart | undefined): Promise<void> {
    if (!part) return
    const mime = part.mimeType ?? ''
    if (part.filename && part.body?.attachmentId) {
      const att = await providerFetch(
        `${GMAIL_API}/messages/${id}/attachments/${part.body.attachmentId}`,
        accessToken,
      )
      out.attachments.push({
        filename: part.filename,
        content_type: mime || 'application/octet-stream',
        size: Number(att.size ?? part.body.size ?? 0),
        content_base64: att.data ? base64UrlToBase64(att.data) : undefined,
      })
    } else if (mime === 'text/plain' && part.body?.data && !out.text) {
      out.text = decodeBase64UrlText(part.body.data)
    } else if (mime === 'text/html' && part.body?.data && !out.html) {
      out.html = decodeBase64UrlText(part.body.data)
    }
    for (const child of part.parts ?? []) await walk(child)
  }
  await walk(m.payload)

  return out
}

// trashGmailMessage moves a message to the Gmail trash (requires gmail.modify).
export async function trashGmailMessage(accessToken: string, id: string): Promise<void> {
  await providerFetch(`${GMAIL_API}/messages/${id}/trash`, accessToken, { method: 'POST' })
}

// ── Microsoft (Graph) ─────────────────────────────────────────────────────────

function randomString(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const values = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(values, (v) => alphabet[v % alphabet.length]).join('')
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// requestMicrosoftAccessToken runs the auth-code + PKCE flow in a popup.
//
// `popup` must be pre-opened synchronously (about:blank) before any async work
// in the calling handler — browsers block window.open once the user gesture
// has been consumed by a prior await (same constraint as the Photos picker).
// The popup lands on public/ms-oauth.html, which posts the code back here.
export async function requestMicrosoftAccessToken(popup: Window | null): Promise<string> {
  if (!MS_CLIENT_ID) {
    popup?.close()
    throw new Error('Microsoft sign-in is not configured (VITE_MS_CLIENT_ID is unset).')
  }
  if (!popup) {
    throw new Error('Could not open the Microsoft sign-in window. Allow popups for this site and try again.')
  }

  const verifier = randomString(64)
  const state = randomString(32)
  const redirectURI = window.location.origin + MS_REDIRECT_PATH
  const challenge = await pkceChallenge(verifier)

  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectURI,
    response_mode: 'query',
    scope: MS_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  })
  popup.location.href = `${MS_AUTHORITY}/authorize?${params}`

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Microsoft sign-in timed out.'))
    }, 5 * 60 * 1000)
    // Detect a user-closed popup; the interval survives cross-origin
    // navigation because ms-oauth.html is same-origin at the end of the flow.
    const closedPoll = setInterval(() => {
      if (popup!.closed) {
        cleanup()
        reject(new Error('cancelled'))
      }
    }, 500)
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return
      const d = e.data
      if (!d || d.type !== 'ms-oauth-callback') return
      cleanup()
      if (d.state !== state) { reject(new Error('Microsoft sign-in failed (state mismatch).')); return }
      if (d.error || !d.code) { reject(new Error(d.errorDescription || d.error || 'Microsoft sign-in failed.')); return }
      resolve(d.code)
    }
    function cleanup() {
      clearTimeout(timeout)
      clearInterval(closedPoll)
      window.removeEventListener('message', onMessage)
      try { popup!.close() } catch { /* ignore */ }
    }
    window.addEventListener('message', onMessage)
  })

  // Exchange the code directly from the browser — the token endpoint allows
  // CORS for SPA-type redirect URIs, and PKCE removes the client-secret need.
  const res = await fetch(`${MS_AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MS_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectURI,
      code_verifier: verifier,
      scope: MS_SCOPES,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Microsoft token exchange failed: ${res.status} ${body}`)
  }
  const data = await res.json()
  if (!data.access_token) throw new Error('Microsoft token exchange returned no access token.')
  return data.access_token as string
}

export async function getMicrosoftUserEmail(accessToken: string): Promise<string | null> {
  try {
    const me = await providerFetch(`${GRAPH_API}/me`, accessToken)
    return (me?.mail || me?.userPrincipalName) ?? null
  } catch {
    return null
  }
}

function graphRecipients(list: any[] | undefined): string {
  return (list ?? [])
    .map((r) => {
      const name = r?.emailAddress?.name ?? ''
      const addr = r?.emailAddress?.address ?? ''
      return name && name !== addr ? `${name} <${addr}>` : addr
    })
    .filter(Boolean)
    .join(', ')
}

// fetchOutlookPage gathers up to PAGE_SIZE messages starting from startUrl,
// following Graph's @odata.nextLink.
async function fetchOutlookPage(
  accessToken: string,
  startUrl: string,
): Promise<{ items: ProviderEmailItem[]; nextUrl: string | null }> {
  const items: ProviderEmailItem[] = []
  let url: string | null = startUrl
  while (url && items.length < PAGE_SIZE) {
    const data = await providerFetch(url, accessToken)
    for (const m of data.value ?? []) {
      const from = graphRecipients(m.from ? [m.from] : [])
      items.push({
        id: m.id,
        provider: 'microsoft',
        from,
        fromAddr: bareAddress(from),
        to: graphRecipients(m.toRecipients),
        subject: m.subject ?? '',
        snippet: m.bodyPreview ?? '',
        date: m.receivedDateTime ?? '',
        starred: m.flag?.flagStatus === 'flagged',
        unread: m.isRead === false,
        hasAttachments: Boolean(m.hasAttachments),
        sizeEstimate: 0,
      })
    }
    url = data['@odata.nextLink'] ?? null
  }
  return { items, nextUrl: url }
}

// listOutlookMessages pages 200 messages at a time — newest first — until
// criteria is satisfied, the mailbox is exhausted, or SAFETY_CAP_EMAILS hits.
// Graph does not report a message size in v1.0 (sizeEstimate stays 0), so
// 'size' criteria isn't offered for this provider — see EmailRetrievalCriteria.
export async function listOutlookMessages(
  accessToken: string,
  criteria: EmailRetrievalCriteria,
  opts: ListMessagesOptions = {},
): Promise<ListMessagesResult> {
  if (criteria.mode === 'size') {
    throw new Error('Retrieving until a target size is not supported for Outlook — Graph does not report message sizes.')
  }

  const items: ProviderEmailItem[] = []
  let url: string | null =
    `${GRAPH_API}/me/messages?$top=100&$orderby=receivedDateTime desc` +
    `&$select=id,subject,from,toRecipients,receivedDateTime,hasAttachments,flag,isRead,bodyPreview`
  let truncated = false
  let stopped = false

  while (url) {
    if (opts.shouldStop?.()) { stopped = true; break }
    const page = await fetchOutlookPage(accessToken, url)
    if (page.items.length === 0) break
    items.push(...page.items)
    emitPage(criteria, items, opts)

    if (items.length >= SAFETY_CAP_EMAILS) { truncated = true; break }
    if (criteriaSatisfied(criteria, items)) break
    if (opts.shouldStop?.()) { stopped = true; break }
    url = page.nextUrl
  }

  return { items: finalizeByCriteria(criteria, items), truncated, stopped }
}

// downloadOutlookMessage fetches the full message body plus attachments.
export async function downloadOutlookMessage(accessToken: string, id: string): Promise<StoredEmailPayload> {
  const m = await providerFetch(
    `${GRAPH_API}/me/messages/${encodeURIComponent(id)}` +
    `?$select=subject,from,toRecipients,receivedDateTime,body,internetMessageId,hasAttachments,bodyPreview`,
    accessToken,
  )

  const out: StoredEmailPayload = {
    message_id: m.internetMessageId || id,
    from: graphRecipients(m.from ? [m.from] : []),
    to: graphRecipients(m.toRecipients),
    subject: m.subject ?? '',
    date: m.receivedDateTime ?? new Date().toISOString(),
    text: m.body?.contentType === 'text' ? (m.body?.content ?? '') : (m.bodyPreview ?? ''),
    html: m.body?.contentType === 'html' ? (m.body?.content ?? '') : '',
    headers: '',
    attachments: [],
  }

  if (m.hasAttachments) {
    const atts = await providerFetch(
      `${GRAPH_API}/me/messages/${encodeURIComponent(id)}/attachments`,
      accessToken,
    )
    for (const a of atts.value ?? []) {
      if (a['@odata.type'] !== '#microsoft.graph.fileAttachment') continue
      out.attachments.push({
        filename: a.name ?? 'attachment',
        content_type: a.contentType ?? 'application/octet-stream',
        size: Number(a.size ?? 0),
        content_base64: a.contentBytes ?? undefined,
      })
    }
  }
  return out
}

// deleteOutlookMessage moves a message to the Deleted Items folder.
export async function deleteOutlookMessage(accessToken: string, id: string): Promise<void> {
  await providerFetch(`${GRAPH_API}/me/messages/${encodeURIComponent(id)}`, accessToken, { method: 'DELETE' })
}

// ── Provider-agnostic wrappers ────────────────────────────────────────────────

export function listProviderMessages(
  provider: EmailProvider,
  accessToken: string,
  criteria: EmailRetrievalCriteria,
  opts: ListMessagesOptions = {},
): Promise<ListMessagesResult> {
  return provider === 'gmail'
    ? listGmailMessages(accessToken, criteria, opts)
    : listOutlookMessages(accessToken, criteria, opts)
}

export function downloadProviderMessage(provider: EmailProvider, accessToken: string, id: string): Promise<StoredEmailPayload> {
  return provider === 'gmail' ? downloadGmailMessage(accessToken, id) : downloadOutlookMessage(accessToken, id)
}

// deleteProviderMessages removes backed-up messages provider-side (Gmail
// trash / Outlook Deleted Items) after a successful backup. Best effort per
// message; returns how many deletions failed.
export async function deleteProviderMessages(
  provider: EmailProvider,
  accessToken: string,
  ids: string[],
): Promise<{ failed: number }> {
  let failed = 0
  for (const id of ids) {
    try {
      if (provider === 'gmail') await trashGmailMessage(accessToken, id)
      else await deleteOutlookMessage(accessToken, id)
    } catch {
      failed++
    }
  }
  return { failed }
}
