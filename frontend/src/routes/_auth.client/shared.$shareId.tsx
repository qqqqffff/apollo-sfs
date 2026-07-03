import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import {
  MdArrowBack,
  MdDownload,
  MdFolder,
  MdInsertDriveFile,
  MdUploadFile,
} from 'react-icons/md'
import {
  getShare,
  getSharedContents,
  getSharedFile,
  sharedDownloadUrl,
  sharedPreviewUrl,
  uploadToShare,
} from '../../api/shares'
import { ApiError } from '../../api/client'
import { useNotification } from '../../context/NotificationContext'
import type { File as ApiFile, Share } from '../../types/api'

export const Route = createFileRoute('/_auth/client/shared/$shareId')({
  validateSearch: (search: Record<string, unknown>) => ({
    folder: typeof search.folder === 'string' ? search.folder : undefined,
    file: typeof search.file === 'string' ? search.file : undefined,
  }),
  component: RouteComponent,
})

function RouteComponent() {
  const { shareId } = Route.useParams()
  const { folder, file } = Route.useSearch()
  const navigate = useNavigate()

  const { data: share, isLoading, error } = useQuery({
    queryKey: ['shares', shareId] as const,
    queryFn: () => getShare(shareId),
    retry: false,
  })

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>

  if (error || !share) {
    const status = error instanceof ApiError ? error.status : 0
    return (
      <div className="flex flex-col items-center py-16 gap-3 text-center">
        <h2 className="text-lg font-semibold text-gray-900 m-0">
          {status === 403 ? 'This share belongs to a different account' : 'Share not found'}
        </h2>
        <p className="text-sm text-gray-500 max-w-sm">
          {status === 403
            ? 'The item was shared with a specific email address. Sign in with the account that received it.'
            : 'The link may have been revoked by the owner or never existed.'}
        </p>
        <button
          onClick={() => navigate({ to: '/client/shared' })}
          className="text-sm text-blue-600 hover:text-blue-700 bg-transparent border-0 cursor-pointer"
        >
          Back to Shared
        </button>
      </div>
    )
  }

  if (share.item_type === 'file') {
    return <SharedFileView share={share} />
  }
  if (file) {
    return (
      <SharedFolderFileView
        share={share}
        fileId={file}
        onBack={() => navigate({
          to: '/client/shared/$shareId',
          params: { shareId },
          search: { folder, file: undefined },
        })}
      />
    )
  }
  return <SharedFolderView share={share} folderId={folder} />
}

// ── Shared single file ────────────────────────────────────────────────────────

function SharedFileView({ share }: { share: Share }) {
  const navigate = useNavigate()
  return (
    <div>
      <button
        onClick={() => navigate({ to: '/client/shared' })}
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 cursor-pointer bg-transparent border-0 p-0 transition-colors mb-4"
      >
        <MdArrowBack className="text-base" /> Shared
      </button>
      <SharedPreview
        name={share.item_name}
        mimeType={share.item_mime_type ?? ''}
        sizeBytes={share.item_size_bytes}
        ownerEmail={share.owner_email}
        previewUrl={sharedPreviewUrl(share.id)}
        downloadUrl={share.can_download ? sharedDownloadUrl(share.id) : null}
      />
    </div>
  )
}

// ── File inside a shared folder ───────────────────────────────────────────────

function SharedFolderFileView({ share, fileId, onBack }: { share: Share; fileId: string; onBack: () => void }) {
  // Metadata comes with the folder listing, but deep links land here directly —
  // fetch the one file through the share-scoped endpoint.
  const { data: file, isLoading, error } = useQuery({
    queryKey: ['shares', share.id, 'file', fileId] as const,
    queryFn: () => getSharedFile(share.id, fileId),
    retry: false,
  })

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (error || !file) {
    return (
      <div>
        <BackRow onClick={onBack} label={share.item_name} />
        <p className="text-sm text-gray-500 mt-4">File not found in this share.</p>
      </div>
    )
  }

  return (
    <div>
      <BackRow onClick={onBack} label={share.item_name} />
      <SharedPreview
        name={file.name}
        mimeType={file.mime_type}
        sizeBytes={file.size_bytes}
        ownerEmail={share.owner_email}
        previewUrl={sharedPreviewUrl(share.id, file.id)}
        downloadUrl={share.can_download ? sharedDownloadUrl(share.id, file.id) : null}
      />
    </div>
  )
}

// ── Shared folder browser ─────────────────────────────────────────────────────

function SharedFolderView({ share, folderId }: { share: Share; folderId?: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { notify } = useNotification()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const contentsKey = ['shares', share.id, 'contents', folderId ?? 'root'] as const
  const { data: contents, isLoading, error } = useQuery({
    queryKey: contentsKey,
    queryFn: () => getSharedContents(share.id, folderId),
    retry: false,
  })

  const atShareRoot = !folderId || folderId === share.folder_id

  function openSubfolder(id: string) {
    navigate({ to: '/client/shared/$shareId', params: { shareId: share.id }, search: { folder: id, file: undefined } })
  }

  function openFile(id: string) {
    navigate({ to: '/client/shared/$shareId', params: { shareId: share.id }, search: { folder: folderId, file: id } })
  }

  function goBack() {
    if (atShareRoot) {
      navigate({ to: '/client/shared' })
      return
    }
    // Parent navigation: hop to the current folder's parent, or back to the
    // share root when the parent is outside the browsable chain.
    const parent = contents?.folder?.parent_id ?? null
    navigate({
      to: '/client/shared/$shareId',
      params: { shareId: share.id },
      search: { folder: parent && parent !== share.folder_id ? parent : undefined, file: undefined },
    })
  }

  async function handleUpload(selected: globalThis.File[]) {
    if (selected.length === 0) return
    setUploading(true)
    let failed = 0
    for (const f of selected) {
      try {
        await uploadToShare(share.id, f, atShareRoot ? undefined : folderId)
      } catch (e) {
        failed++
        notify('error', e instanceof ApiError ? `${f.name}: ${e.message}` : `Failed to upload ${f.name}`)
      }
    }
    setUploading(false)
    if (failed < selected.length) {
      notify('success', `Uploaded ${selected.length - failed} file${selected.length - failed !== 1 ? 's' : ''}`)
    }
    queryClient.invalidateQueries({ queryKey: ['shares', share.id, 'contents'] })
  }

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (error || !contents) {
    return (
      <div>
        <BackRow onClick={() => navigate({ to: '/client/shared' })} label="Shared" />
        <p className="text-sm text-gray-500 mt-4">Could not open this shared folder.</p>
      </div>
    )
  }

  const subfolders = contents.subfolders?.items ?? []
  const files = contents.files?.items ?? []
  const folderName = contents.folder?.name ?? share.item_name

  return (
    <div>
      <BackRow onClick={goBack} label={atShareRoot ? 'Shared' : 'Back'} />
      <div className="flex items-center gap-3 mb-1 mt-2">
        <h2 className="text-lg font-semibold text-gray-900 m-0">{folderName}</h2>
        <span className="text-xs text-gray-400">shared by {share.owner_email}</span>
      </div>
      <p className="text-xs text-gray-400 mb-4">
        {share.can_upload ? 'You can view, upload and download here.' : share.can_download ? 'You can view and download here.' : 'View-only access.'}
      </p>

      {share.can_upload && (
        <div className="mb-4">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const selected = Array.from(e.target.files ?? [])
              e.target.value = ''
              handleUpload(selected)
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors disabled:opacity-50"
          >
            <MdUploadFile className="text-base" /> {uploading ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      )}

      {subfolders.length === 0 && files.length === 0 && (
        <p className="text-sm text-gray-400">This folder is empty.</p>
      )}

      {subfolders.length > 0 && (
        <section className="mb-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Folders</h3>
          <ul className="list-none m-0 p-0">
            {subfolders.map((f) => (
              <li key={f.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 transition-colors">
                <button
                  onClick={() => openSubfolder(f.id)}
                  className="flex-1 flex items-center gap-2 bg-transparent border-0 cursor-pointer text-left text-sm text-gray-800 hover:text-gray-900 p-0 min-w-0"
                >
                  <MdFolder className="text-blue-400 text-lg shrink-0" />
                  <span className="truncate">{f.name}</span>
                </button>
                <span className="text-xs text-gray-400 shrink-0">{formatSize(f.size_bytes)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {files.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Files</h3>
          <ul className="list-none m-0 p-0">
            {files.map((f: ApiFile) => (
              <li key={f.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 transition-colors">
                <button
                  onClick={() => openFile(f.id)}
                  className="flex-1 flex items-center gap-2 bg-transparent border-0 cursor-pointer text-left text-sm text-gray-800 hover:text-gray-900 p-0 min-w-0"
                >
                  <MdInsertDriveFile className="text-gray-400 text-lg shrink-0" />
                  <span className="truncate">{f.name}</span>
                </button>
                <span className="text-xs text-gray-400 shrink-0">{formatSize(f.size_bytes)}</span>
                {share.can_download && (
                  <a
                    href={sharedDownloadUrl(share.id, f.id)}
                    title="Download"
                    className="text-gray-300 hover:text-blue-500 transition-colors p-0.5"
                  >
                    <MdDownload className="text-lg" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

// ── Shared preview ────────────────────────────────────────────────────────────

type PreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'unsupported'

function previewKind(mimeType: string): PreviewKind {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return 'text'
  return 'unsupported'
}

// SharedPreview renders a file inline through the share-scoped preview
// endpoint. Unlike FilePreviewModal it never uses owner-only presign/stream
// endpoints, and it hides the download action when the share forbids it.
function SharedPreview({ name, mimeType, sizeBytes, ownerEmail, previewUrl, downloadUrl }: {
  name: string
  mimeType: string
  sizeBytes: number
  ownerEmail?: string
  previewUrl: string
  downloadUrl: string | null
}) {
  const kind = previewKind(mimeType)

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden mt-2">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 gap-4 min-w-0">
        <div className="min-w-0">
          <span className="block font-medium text-gray-900 text-sm truncate">{name}</span>
          <span className="block text-xs text-gray-400">
            {formatSize(sizeBytes)}{ownerEmail ? ` · shared by ${ownerEmail}` : ''}
          </span>
        </div>
        {downloadUrl && (
          <a
            href={downloadUrl}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900 transition-colors shrink-0"
          >
            <MdDownload className="text-base" /> Download
          </a>
        )}
      </div>

      <div className="flex items-center justify-center bg-gray-50 min-h-64">
        {kind === 'image' && (
          <img src={previewUrl} alt={name} className="max-w-full max-h-[75svh] object-contain block" />
        )}
        {kind === 'pdf' && (
          <iframe src={previewUrl} title={name} className="w-full h-[75svh] border-0 block" />
        )}
        {kind === 'video' && (
          <video src={previewUrl} controls playsInline preload="metadata" className="max-w-full max-h-[75svh] block" />
        )}
        {kind === 'audio' && (
          <audio src={previewUrl} controls className="w-full max-w-md my-16" />
        )}
        {kind === 'text' && (
          <iframe src={previewUrl} title={name} sandbox="allow-same-origin" className="w-full h-[60svh] border-0 block bg-white" />
        )}
        {kind === 'unsupported' && (
          <div className="p-16 text-center text-gray-500 text-sm">
            <MdInsertDriveFile className="text-5xl text-gray-300 mx-auto mb-3" />
            <p className="mb-2">Preview not available for this file type.</p>
            {downloadUrl
              ? <a href={downloadUrl} className="text-blue-600 hover:underline">Download instead</a>
              : <p className="text-xs text-gray-400">Downloads are not permitted for this share.</p>}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function BackRow({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 cursor-pointer bg-transparent border-0 p-0 transition-colors"
    >
      <MdArrowBack className="text-base" /> {label}
    </button>
  )
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
