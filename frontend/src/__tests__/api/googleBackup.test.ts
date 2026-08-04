import type { BackupEntry, GoogleBackupItem } from '../../api/googleBackup'
import type { BackupProgressEvent } from '../../api/backupControl'

jest.mock('../../api/client', () => ({
  post: jest.fn(),
  uploadWithProgress: jest.fn(),
}))

import { post, uploadWithProgress } from '../../api/client'
import { uploadGoogleEntries } from '../../api/googleBackup'

const mockPost = post as jest.Mock
const mockUploadWithProgress = uploadWithProgress as jest.Mock

function fakeReader(chunks: Uint8Array[]) {
  let i = 0
  return {
    read: jest.fn(async () => {
      if (i < chunks.length) return { done: false, value: chunks[i++] }
      return { done: true, value: undefined }
    }),
  }
}

function fakeFetchResponse(opts: { contentLength?: string | null; chunks: Uint8Array[] }) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === 'Content-Length' ? opts.contentLength ?? null : null) },
    body: { getReader: () => fakeReader(opts.chunks) },
    blob: jest.fn().mockResolvedValue(new Blob(opts.chunks.map((c) => new Uint8Array(c)))),
  }
}

function driveEntry(overrides: Partial<GoogleBackupItem> = {}): BackupEntry {
  return {
    googleItem: {
      id: 'g1', name: 'video.mp4', mimeType: 'video/mp4', size: 6_000_000,
      modifiedTime: '', source: 'drive', isGoogleDoc: false, baseUrl: null, thumbnailLink: null,
      ...overrides,
    },
    name: 'video.mp4', type: 'video/mp4', destFolderId: null,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPost.mockResolvedValue({ exists: false })
})

describe('uploadGoogleEntries — incremental progress for large files', () => {
  test('reports download progress as chunks stream in and upload progress from the XHR callback, not just start/settled', async () => {
    const chunkA = new Uint8Array(3_000_000)
    const chunkB = new Uint8Array(3_000_000)
    global.fetch = jest.fn().mockResolvedValue(fakeFetchResponse({ contentLength: '6000000', chunks: [chunkA, chunkB] }))
    mockUploadWithProgress.mockImplementation(async (_path: string, _form: FormData, onProgress: (l: number, t: number) => void) => {
      onProgress(3_000_000, 6_000_000)
      onProgress(6_000_000, 6_000_000)
      return { id: 'f1', size_bytes: 6_000_000, drive_id: 'drive-1' }
    })

    const events: BackupProgressEvent<BackupEntry>[] = []
    const res = await uploadGoogleEntries([driveEntry()], 'token', { onProgress: (e) => events.push(e) })

    const downloadEvents = events.filter((e) => e.phase === 'progress' && e.stage === 'downloading')
    expect(downloadEvents.map((e) => e.loadedBytes)).toEqual([3_000_000, 6_000_000])
    expect(downloadEvents[0].itemTotalBytes).toBe(6_000_000)

    const uploadEvents = events.filter((e) => e.phase === 'progress' && e.stage === 'uploading')
    expect(uploadEvents.map((e) => e.loadedBytes)).toEqual([3_000_000, 6_000_000])
    expect(uploadEvents[0].itemTotalBytes).toBe(6_000_000)

    // Both phases fire strictly between 'start' and 'settled', in order.
    const phases = events.map((e) => e.phase)
    expect(phases[0]).toBe('start')
    expect(phases[phases.length - 1]).toBe('settled')
    expect(phases.slice(1, -1).every((p) => p === 'progress')).toBe(true)

    expect(res).toMatchObject({ uploaded: 1, errors: 0, cancelled: false })
  })

  test('leaves itemTotalBytes undefined for the download stage when neither Content-Length nor a known size exists (a Photos item)', async () => {
    const chunk = new Uint8Array(1024)
    global.fetch = jest.fn().mockResolvedValue(fakeFetchResponse({ contentLength: null, chunks: [chunk] }))
    mockUploadWithProgress.mockResolvedValue({ id: 'f2', size_bytes: 1024, drive_id: null })

    const entry: BackupEntry = {
      googleItem: {
        id: 'p1', name: 'photo.jpg', mimeType: 'image/jpeg', size: null,
        modifiedTime: '', source: 'photos', isGoogleDoc: false,
        baseUrl: 'https://example.com/photo', thumbnailLink: null,
      },
      name: 'photo.jpg', type: 'image/jpeg', destFolderId: null,
    }

    const events: BackupProgressEvent<BackupEntry>[] = []
    await uploadGoogleEntries([entry], 'token', { onProgress: (e) => events.push(e) })

    const downloadEvent = events.find((e) => e.phase === 'progress' && e.stage === 'downloading')
    expect(downloadEvent?.itemTotalBytes).toBeUndefined()
    expect(downloadEvent?.loadedBytes).toBe(1024)
  })

  test('a duplicate file downloads (for hashing) but never reaches the upload stage', async () => {
    const chunk = new Uint8Array(2048)
    global.fetch = jest.fn().mockResolvedValue(fakeFetchResponse({ contentLength: '2048', chunks: [chunk] }))
    mockPost.mockResolvedValue({ exists: true })

    const events: BackupProgressEvent<BackupEntry>[] = []
    const res = await uploadGoogleEntries([driveEntry()], 'token', { onProgress: (e) => events.push(e) })

    expect(events.some((e) => e.phase === 'progress' && e.stage === 'downloading')).toBe(true)
    expect(events.some((e) => e.phase === 'progress' && e.stage === 'uploading')).toBe(false)
    expect(mockUploadWithProgress).not.toHaveBeenCalled()
    expect(res).toMatchObject({ uploaded: 0, duplicates: 1 })
  })
})
