import { useState, useCallback } from 'react'
import type { File as ApiFile, Folder } from '../types/api'

export type SortKey = 'name' | 'date' | 'size'
export type SortDir = 'asc' | 'desc'

export interface SortState {
  key: SortKey
  dir: SortDir
}

export function useSort(initial: SortKey = 'name'): {
  sort: SortState
  onSort: (key: SortKey) => void
} {
  const [sort, setSort] = useState<SortState>({ key: initial, dir: 'asc' })

  const onSort = useCallback((key: SortKey) => {
    setSort((prev) => ({
      key,
      dir: prev.key === key ? (prev.dir === 'asc' ? 'desc' : 'asc') : 'asc',
    }))
  }, [])

  return { sort, onSort }
}

// ── Sorting helpers ───────────────────────────────────────────────────────────

const dir = (cmp: number, sortDir: SortDir) => (sortDir === 'asc' ? cmp : -cmp)

export function sortedFolders(items: Folder[], sort: SortState): Folder[] {
  return [...items].sort((a, b) => {
    if (sort.key === 'date')
      return dir(
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        sort.dir,
      )
    // 'name' and 'size' (folders have no size — fall back to name)
    return dir(a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }), sort.dir)
  })
}

export function sortedFiles(items: ApiFile[], sort: SortState): ApiFile[] {
  return [...items].sort((a, b) => {
    if (sort.key === 'date')
      return dir(
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        sort.dir,
      )
    if (sort.key === 'size') return dir(a.size_bytes - b.size_bytes, sort.dir)
    return dir(a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }), sort.dir)
  })
}
