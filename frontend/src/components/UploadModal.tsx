import { useEffect } from 'react'
import type { User } from '../types/api'

interface Props {
  files: globalThis.File[]
  folderName: string
  user: User
  onConfirm: () => void
  onCancel: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function UploadModal({ files, folderName, user, onConfirm, onCancel }: Props) {
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
  const usedBytes = user.storage_used_bytes
  const quotaBytes = user.storage_quota_bytes
  const afterBytes = usedBytes + totalBytes
  const exceedsQuota = afterBytes > quotaBytes

  const usedPct = quotaBytes > 0 ? Math.min((usedBytes / quotaBytes) * 100, 100) : 0
  const uploadPct = quotaBytes > 0 ? Math.min((totalBytes / quotaBytes) * 100, 100 - usedPct) : 0
  const remainingAfter = Math.max(quotaBytes - afterBytes, 0)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 8,
          padding: 24,
          width: 500,
          maxWidth: '92vw',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
      >
        <h3 style={{ margin: 0 }}>Upload files</h3>

        {/* Destination */}
        <div style={{ fontSize: 13, color: '#555' }}>
          Uploading to: <strong style={{ color: '#222' }}>📁 {folderName}</strong>
        </div>

        {/* File list */}
        <div
          style={{
            border: '1px solid #ddd',
            borderRadius: 4,
            overflow: 'auto',
            maxHeight: 240,
            flex: '0 1 auto',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f5f5f5', position: 'sticky', top: 0 }}>
                <th style={{ padding: '7px 10px', fontWeight: 600, textAlign: 'left' }}>File</th>
                <th style={{ padding: '7px 10px', fontWeight: 600, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  Size
                </th>
              </tr>
            </thead>
            <tbody>
              {files.map((f, i) => (
                <tr key={i} style={{ borderTop: '1px solid #eee' }}>
                  <td
                    style={{
                      padding: '6px 10px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: 320,
                    }}
                    title={f.name}
                  >
                    {f.name}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#555', whiteSpace: 'nowrap' }}>
                    {formatSize(f.size)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid #ddd', background: '#fafafa' }}>
                <td style={{ padding: '6px 10px', fontWeight: 600 }}>
                  {files.length} file{files.length !== 1 ? 's' : ''}
                </td>
                <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  {formatSize(totalBytes)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Quota */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div
            style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#555' }}
          >
            <span>Storage</span>
            <span>
              {formatSize(usedBytes)} of {formatSize(quotaBytes)} used
            </span>
          </div>

          {/* Bar */}
          <div
            style={{
              height: 10,
              borderRadius: 5,
              background: '#e5e5e5',
              overflow: 'hidden',
              display: 'flex',
            }}
          >
            <div style={{ width: `${usedPct}%`, background: '#4a90e2' }} />
            <div
              style={{
                width: `${uploadPct}%`,
                background: exceedsQuota ? '#e53e3e' : '#f6ad55',
              }}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span style={{ color: '#555' }}>After upload: {formatSize(afterBytes)}</span>
            {exceedsQuota ? (
              <span style={{ color: '#e53e3e', fontWeight: 600 }}>
                Exceeds quota by {formatSize(afterBytes - quotaBytes)}
              </span>
            ) : (
              <span style={{ color: '#555' }}>{formatSize(remainingAfter)} remaining</span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button onClick={onCancel}>Cancel</button>
          <button onClick={onConfirm} disabled={exceedsQuota}>
            {`Upload ${files.length > 1 ? `${files.length} files` : 'file'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
