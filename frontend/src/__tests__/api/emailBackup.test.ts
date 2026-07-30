import {
  ensureEmailBackupFolder,
  backupEmailMessage,
  listEmailBackupSenders,
  listEmailBackupMessages,
  getEmailBackupMessage,
  markEmailBackupMessageRead,
  deleteEmailBackupMessage,
  completeEmailBackupRun,
  backupEmailEntries,
  emailBackupSendersQueryOptions,
  emailBackupMessagesInfiniteQueryOptions,
  loadEmailBackupSettings,
  removeBackedUpMessages,
  saveEmailBackupSettings,
} from '../../api/emailBackup'
import { createBackupControl } from '../../api/backupControl'
import type { ProviderEmailItem, StoredEmailPayload } from '../../api/emailProviders'
import type { EmailBackupMessage } from '../../types/emailBackup'
import type { PageResult } from '../../types/api'

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: jest.fn().mockResolvedValue(body),
  })
}

function lastCall() {
  return (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
}
function lastUrl() { return lastCall()[0] }
function lastInit() { return lastCall()[1] }
function lastBody() { return JSON.parse(lastInit().body as string) }

const item: ProviderEmailItem = {
  id: 'msg-1',
  provider: 'gmail',
  from: 'Jane <jane@x.com>',
  fromAddr: 'jane@x.com',
  to: 'me@y.com',
  subject: 'Hello',
  snippet: 'Hello there',
  date: '2026-07-01T00:00:00Z',
  starred: true,
  unread: false,
  hasAttachments: false,
  sizeEstimate: 1024,
}

const payload: StoredEmailPayload = {
  message_id: '<abc@x.com>',
  from: 'Jane <jane@x.com>',
  to: 'me@y.com',
  subject: 'Hello',
  date: '2026-07-01T00:00:00Z',
  text: 'Hello there',
  html: '',
  headers: '',
  attachments: [],
}

describe('ensureEmailBackupFolder', () => {
  it('POSTs /email-backup/folders with the address and drive', async () => {
    mockFetch(201, { folder: { id: 'f1' }, created: true })
    await ensureEmailBackupFolder('user@example.com', 'drive-1')
    expect(lastUrl()).toBe('/api/v1/email-backup/folders')
    expect(lastInit().method).toBe('POST')
    expect(lastBody()).toEqual({ email_address: 'user@example.com', drive_id: 'drive-1' })
  })

  it('sends drive_id null when omitted', async () => {
    mockFetch(200, { folder: { id: 'f1' }, created: false })
    await ensureEmailBackupFolder('user@example.com')
    expect(lastBody()).toEqual({ email_address: 'user@example.com', drive_id: null })
  })
})

describe('backupEmailMessage', () => {
  it('POSTs /email-backup/messages with item metadata and message body', async () => {
    mockFetch(201, { id: 'row-1' })
    await backupEmailMessage('f1', item, payload)
    expect(lastUrl()).toBe('/api/v1/email-backup/messages')
    expect(lastBody()).toEqual({
      folder_id: 'f1',
      provider: 'gmail',
      provider_message_id: 'msg-1',
      snippet: 'Hello there',
      starred: true,
      message: payload,
    })
  })
})

describe('viewer endpoints', () => {
  it('GETs senders', async () => {
    mockFetch(200, { senders: [] })
    await listEmailBackupSenders('f1')
    expect(lastUrl()).toBe('/api/v1/email-backup/folders/f1/senders')
  })

  it('GETs messages with sender, cursor and limit', async () => {
    mockFetch(200, { items: [], next_token: '' })
    await listEmailBackupMessages('f1', 'jane@x.com', 'cur-1', 25)
    expect(lastUrl()).toBe('/api/v1/email-backup/folders/f1/messages?sender=jane%40x.com&cursor=cur-1&limit=25')
  })

  it('GETs message detail', async () => {
    mockFetch(200, { id: 'row-1' })
    await getEmailBackupMessage('row-1')
    expect(lastUrl()).toBe('/api/v1/email-backup/messages/row-1')
  })

  it('PATCHes read', async () => {
    mockFetch(200, { message: 'ok' })
    await markEmailBackupMessageRead('row-1')
    expect(lastUrl()).toBe('/api/v1/email-backup/messages/row-1/read')
    expect(lastInit().method).toBe('PATCH')
  })

  it('DELETEs a message', async () => {
    mockFetch(200, { message: 'deleted' })
    await deleteEmailBackupMessage('row-1')
    expect(lastUrl()).toBe('/api/v1/email-backup/messages/row-1')
    expect(lastInit().method).toBe('DELETE')
  })
})

describe('completeEmailBackupRun', () => {
  it('POSTs /email-backup/runs', async () => {
    mockFetch(201, { id: 'run-1' })
    await completeEmailBackupRun({
      folder_id: 'f1',
      email_address: 'user@example.com',
      provider: 'gmail',
      uploaded: 3,
      duplicates: 1,
      errors: 0,
      notify: true,
    })
    expect(lastUrl()).toBe('/api/v1/email-backup/runs')
    expect(lastBody()).toMatchObject({ uploaded: 3, duplicates: 1, errors: 0, notify: true })
  })
})

// Gmail download (format=full) + backend upload per item. The Gmail response
// payload is minimal — the parser tolerates missing parts.
const gmailResponse = {
  ok: true, status: 200,
  json: async () => ({ id: 'x', internalDate: '1750000000000', payload: { headers: [] } }),
}

function mockBackupFetch(backendStatuses: number[]) {
  let call = 0
  global.fetch = jest.fn().mockImplementation((url: string) => {
    if (url.startsWith('https://gmail.googleapis.com/')) return Promise.resolve(gmailResponse)
    const status = backendStatuses[Math.min(call++, backendStatuses.length - 1)]
    return Promise.resolve({
      ok: status < 300, status, statusText: '',
      json: async () => (status < 300
        ? { id: `row-${call}`, file_id: `file-${call}`, file_name: 'msg.email.json', file_size_bytes: 2048 }
        : { error: 'email already backed up' }),
    })
  })
}

describe('backupEmailEntries', () => {
  it('counts uploads, duplicates (409), and errors, and tracks backed-up ids', async () => {
    const items: ProviderEmailItem[] = [
      { ...item, id: 'a' },
      { ...item, id: 'b' },
      { ...item, id: 'c' },
    ]
    mockBackupFetch([201, 409, 500])

    const progress: [number, number][] = []
    const res = await backupEmailEntries(items, 'gmail', 'token', 'f1', {
      onProgress: (e) => { if (e.phase === 'settled') progress.push([e.done, e.total]) },
    })

    expect(res.uploaded).toBe(1)
    expect(res.duplicates).toBe(1)
    expect(res.errors).toBe(1)
    expect(res.cancelled).toBe(false)
    // Uploaded and duplicate messages are safe to delete provider-side.
    expect(res.backedUpIds).toEqual(['a', 'b'])
    // Only real uploads are rollback candidates.
    expect(res.uploadedMessageIds).toEqual(['row-1'])
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]])
  })

  it('reports the destination path and stored size of each message', async () => {
    mockBackupFetch([201])
    const events: { phase: string; path: string; sizeBytes?: number }[] = []
    await backupEmailEntries([item], 'gmail', 'token', 'f1', {
      folderName: 'user@example.com',
      onProgress: (e) => events.push({ phase: e.phase, path: e.path, sizeBytes: e.sizeBytes }),
    })

    // Before the upload the subject stands in for the not-yet-known file name;
    // afterwards it is the real stored path.
    expect(events[0]).toEqual({ phase: 'start', path: 'user@example.com/Hello', sizeBytes: undefined })
    expect(events[1]).toEqual({
      phase: 'settled', path: 'user@example.com/msg.email.json', sizeBytes: 2048,
    })
  })

  it('stops at the next message when the run is cancelled', async () => {
    const items: ProviderEmailItem[] = [
      { ...item, id: 'a' },
      { ...item, id: 'b' },
      { ...item, id: 'c' },
    ]
    mockBackupFetch([201])
    const control = createBackupControl()

    const res = await backupEmailEntries(items, 'gmail', 'token', 'f1', {
      control,
      // Cancel once the first message has landed — the second must never start.
      onProgress: (e) => { if (e.phase === 'settled' && e.index === 0) control.cancel() },
    })

    expect(res.cancelled).toBe(true)
    expect(res.uploaded).toBe(1)
    expect(res.uploadedMessageIds).toHaveLength(1)
  })

  it('holds the loop while paused and continues on resume', async () => {
    const items: ProviderEmailItem[] = [{ ...item, id: 'a' }, { ...item, id: 'b' }]
    mockBackupFetch([201])
    const control = createBackupControl()
    control.pause()

    let done = false
    const run = backupEmailEntries(items, 'gmail', 'token', 'f1', { control }).then((r) => {
      done = true
      return r
    })

    // Nothing may be sent while paused.
    await Promise.resolve()
    expect(done).toBe(false)
    expect(global.fetch).not.toHaveBeenCalled()

    control.resume()
    const res = await run
    expect(res.uploaded).toBe(2)
  })
})

describe('removeBackedUpMessages', () => {
  it('deletes each message and counts failures', async () => {
    let call = 0
    global.fetch = jest.fn().mockImplementation(() => {
      const ok = call++ === 0
      return Promise.resolve({
        ok, status: ok ? 200 : 500, statusText: '',
        json: async () => (ok ? { message: 'deleted' } : { error: 'nope' }),
      })
    })

    expect(await removeBackedUpMessages(['row-1', 'row-2'])).toEqual({ removed: 1, failed: 1 })
  })
})

describe('query options', () => {
  it('keys senders by folder', () => {
    expect(emailBackupSendersQueryOptions('f1').queryKey).toEqual(['email-backup', 'f1', 'senders'])
  })

  it('keys messages by folder and sender, deriving next page from next_token', () => {
    expect(emailBackupMessagesInfiniteQueryOptions('f1').queryKey)
      .toEqual(['email-backup', 'f1', 'messages', 'all'])
    expect(emailBackupMessagesInfiniteQueryOptions('f1', 'jane@x.com').queryKey)
      .toEqual(['email-backup', 'f1', 'messages', 'jane@x.com'])
    const opts = emailBackupMessagesInfiniteQueryOptions('f1')
    const page: PageResult<EmailBackupMessage> = { items: [], next_token: 'tok-2' }
    expect(opts.getNextPageParam(page)).toBe('tok-2')
    expect(opts.getNextPageParam({ items: [], next_token: '' })).toBeUndefined()
  })
})

describe('email backup settings', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to deleteAfter off, notify on, background on', () => {
    expect(loadEmailBackupSettings()).toEqual({ deleteAfter: false, notify: true, background: true })
  })

  it('round-trips through localStorage', () => {
    saveEmailBackupSettings({ deleteAfter: true, notify: false, background: false })
    expect(loadEmailBackupSettings()).toEqual({ deleteAfter: true, notify: false, background: false })
  })
})
