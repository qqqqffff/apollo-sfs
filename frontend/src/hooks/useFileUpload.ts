import { useState, useCallback } from 'react'
import { uploadFile } from '../api/files'

export type UploadStatus = 'idle' | 'uploading' | 'complete' | 'partial' | 'allFailed'

export interface UploadProgress {
  total: number
  succeeded: number
  failed: number
  status: UploadStatus
}

const MAX_RETRIES = 5
// Exponential backoff: 500ms, 1s, 2s, 4s, 8s between attempts 1–5
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function uploadWithRetry(folderId: string, file: globalThis.File): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1])
    try {
      await uploadFile(folderId, file)
      return
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err
    }
  }
}

export function useFileUpload() {
  const [progress, setProgress] = useState<UploadProgress>({
    total: 0,
    succeeded: 0,
    failed: 0,
    status: 'idle',
  })

  const startUpload = useCallback(async (
    files: globalThis.File[],
    folderId: string,
    onAnySuccess: () => void,
  ) => {
    const total = files.length
    let succeededCount = 0
    let failedCount = 0

    setProgress({ total, succeeded: 0, failed: 0, status: 'uploading' })

    await Promise.all(
      files.map(async (file) => {
        try {
          await uploadWithRetry(folderId, file)
          succeededCount++
          setProgress((prev) => ({ ...prev, succeeded: prev.succeeded + 1 }))
        } catch {
          failedCount++
          setProgress((prev) => ({ ...prev, failed: prev.failed + 1 }))
        }
      }),
    )

    const finalStatus: UploadStatus =
      failedCount === 0 ? 'complete' : succeededCount === 0 ? 'allFailed' : 'partial'

    setProgress((prev) => ({ ...prev, status: finalStatus }))

    if (succeededCount > 0) onAnySuccess()
  }, [])

  const dismiss = useCallback(() => {
    setProgress({ total: 0, succeeded: 0, failed: 0, status: 'idle' })
  }, [])

  return { progress, startUpload, dismiss }
}
