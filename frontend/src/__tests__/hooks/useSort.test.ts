import { renderHook, act } from '@testing-library/react'
import { useSort, sortedFiles, sortedFolders } from '../../hooks/useSort'
import type { Folder, File as ApiFile } from '../../types/api'

// ── useSort hook ──────────────────────────────────────────────────────────────

describe('useSort', () => {
  test('initialises with name asc by default', () => {
    const { result } = renderHook(() => useSort())
    expect(result.current.sort).toEqual({ key: 'name', dir: 'asc' })
  })

  test('accepts a custom initial key', () => {
    const { result } = renderHook(() => useSort('date'))
    expect(result.current.sort.key).toBe('date')
    expect(result.current.sort.dir).toBe('asc')
  })

  test('calling onSort with the same key toggles asc → desc', () => {
    const { result } = renderHook(() => useSort())
    act(() => result.current.onSort('name'))
    expect(result.current.sort).toEqual({ key: 'name', dir: 'desc' })
  })

  test('calling onSort with the same key again toggles desc → asc', () => {
    const { result } = renderHook(() => useSort())
    act(() => result.current.onSort('name'))
    act(() => result.current.onSort('name'))
    expect(result.current.sort).toEqual({ key: 'name', dir: 'asc' })
  })

  test('switching to a different key resets direction to asc', () => {
    const { result } = renderHook(() => useSort())
    act(() => result.current.onSort('name')) // now desc
    act(() => result.current.onSort('date')) // new key → asc
    expect(result.current.sort).toEqual({ key: 'date', dir: 'asc' })
  })
})

// ── sortedFiles ───────────────────────────────────────────────────────────────

const files = [
  { name: 'zebra.txt', size_bytes: 500, created_at: '2024-01-03T00:00:00Z' },
  { name: 'alpha.txt', size_bytes: 100, created_at: '2024-01-01T00:00:00Z' },
  { name: 'mango.txt', size_bytes: 300, created_at: '2024-01-02T00:00:00Z' },
] as unknown as ApiFile[]

describe('sortedFiles', () => {
  test('sorts by name ascending', () => {
    const result = sortedFiles(files, { key: 'name', dir: 'asc' })
    expect(result.map((f) => f.name)).toEqual(['alpha.txt', 'mango.txt', 'zebra.txt'])
  })

  test('sorts by name descending', () => {
    const result = sortedFiles(files, { key: 'name', dir: 'desc' })
    expect(result.map((f) => f.name)).toEqual(['zebra.txt', 'mango.txt', 'alpha.txt'])
  })

  test('sorts by size ascending', () => {
    const result = sortedFiles(files, { key: 'size', dir: 'asc' })
    expect(result.map((f) => f.size_bytes)).toEqual([100, 300, 500])
  })

  test('sorts by size descending', () => {
    const result = sortedFiles(files, { key: 'size', dir: 'desc' })
    expect(result.map((f) => f.size_bytes)).toEqual([500, 300, 100])
  })

  test('sorts by date ascending', () => {
    const result = sortedFiles(files, { key: 'date', dir: 'asc' })
    expect(result.map((f) => f.name)).toEqual(['alpha.txt', 'mango.txt', 'zebra.txt'])
  })

  test('sorts by date descending', () => {
    const result = sortedFiles(files, { key: 'date', dir: 'desc' })
    expect(result.map((f) => f.name)).toEqual(['zebra.txt', 'mango.txt', 'alpha.txt'])
  })

  test('does not mutate the original array', () => {
    const original = [...files]
    sortedFiles(files, { key: 'size', dir: 'asc' })
    expect(files).toEqual(original)
  })
})

// ── sortedFolders ─────────────────────────────────────────────────────────────

const folders = [
  { name: 'Zeta',  created_at: '2024-01-03T00:00:00Z' },
  { name: 'Alpha', created_at: '2024-01-01T00:00:00Z' },
  { name: 'Mu',    created_at: '2024-01-02T00:00:00Z' },
] as unknown as Folder[]

describe('sortedFolders', () => {
  test('sorts by name ascending', () => {
    const result = sortedFolders(folders, { key: 'name', dir: 'asc' })
    expect(result.map((f) => f.name)).toEqual(['Alpha', 'Mu', 'Zeta'])
  })

  test('sorts by name descending', () => {
    const result = sortedFolders(folders, { key: 'name', dir: 'desc' })
    expect(result.map((f) => f.name)).toEqual(['Zeta', 'Mu', 'Alpha'])
  })

  test('sorts by date ascending', () => {
    const result = sortedFolders(folders, { key: 'date', dir: 'asc' })
    expect(result.map((f) => f.name)).toEqual(['Alpha', 'Mu', 'Zeta'])
  })

  test('sorts by date descending', () => {
    const result = sortedFolders(folders, { key: 'date', dir: 'desc' })
    expect(result.map((f) => f.name)).toEqual(['Zeta', 'Mu', 'Alpha'])
  })

  test('falls back to name sort for size key (folders have no size)', () => {
    const result = sortedFolders(folders, { key: 'size', dir: 'asc' })
    expect(result.map((f) => f.name)).toEqual(['Alpha', 'Mu', 'Zeta'])
  })

  test('does not mutate the original array', () => {
    const original = [...folders]
    sortedFolders(folders, { key: 'name', dir: 'desc' })
    expect(folders).toEqual(original)
  })
})
