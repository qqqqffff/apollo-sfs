import { useEffect } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { listRoot, getFolder } from '../api/folders'
import { adminListUserRoot, adminGetUserFolder } from '../api/admin'
import { searchContent } from '../api/search'
import type { Folder, File, FolderContents } from '../types/api'

// Opaque page param tracking independent cursor state for the two sub-lists.
interface PageParam {
  folderCursor?: string
  fileCursor?: string
  folderDone: boolean
  fileDone: boolean
}

const INITIAL_PARAM: PageParam = {
  folderCursor: undefined,
  fileCursor: undefined,
  folderDone: false,
  fileDone: false,
}

function fetchPage(folderId: string | 'root', search: string, param: PageParam, asUsername?: string) {
  const p = {
    folderCursor: param.folderDone ? undefined : param.folderCursor,
    fileCursor: param.fileDone ? undefined : param.fileCursor,
    // limit=0 tells the backend to skip that list (no DB query)
    folderLimit: param.folderDone ? 0 : undefined,
    fileLimit: param.fileDone ? 0 : undefined,
  }
  if (asUsername) {
    return folderId === 'root'
      ? adminListUserRoot(asUsername, p)
      : adminGetUserFolder(asUsername, folderId, p)
  }
  if (search) return searchContent(search, p)
  return folderId === 'root' ? listRoot(p) : getFolder(folderId, p)
}

function nextParam(lastPage: FolderContents, lastParam: PageParam): PageParam | undefined {
  const nextFolder = lastPage.subfolders.next_token || undefined
  const nextFile = lastPage.files.next_token || undefined
  const folderDone = lastParam.folderDone || !nextFolder
  const fileDone = lastParam.fileDone || !nextFile
  if (folderDone && fileDone) return undefined
  return { folderCursor: nextFolder, fileCursor: nextFile, folderDone, fileDone }
}

export interface InfiniteFolderContents {
  folder: Folder | null
  folders: Folder[]
  files: File[]
  isLoading: boolean
  error: Error | null
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => void
}

export function useInfiniteFolderContents(
  folderId: string | 'root',
  search: string,
  asUsername?: string,
): InfiniteFolderContents {
  const query = useInfiniteQuery({
    // Key includes asUsername so impersonated browsing is isolated from own data
    queryKey: ['folders', folderId, 'contents', search, asUsername ?? ''],
    queryFn: ({ pageParam }) => fetchPage(folderId, search, pageParam as PageParam, asUsername),
    initialPageParam: INITIAL_PARAM as PageParam,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      nextParam(lastPage, lastPageParam as PageParam),
  })

  const { data, hasNextPage, isFetchingNextPage, fetchNextPage } = query

  // Auto-advance to the next page when the current page returns zero items
  // but more pages exist. This ensures search results are found even when an
  // entire DB page contains no name matches for the current query term.
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage || !data) return
    const pages = data.pages
    const last = pages[pages.length - 1]
    if (last.subfolders.items.length === 0 && last.files.items.length === 0) {
      fetchNextPage()
    }
  }, [data, hasNextPage, isFetchingNextPage, fetchNextPage])

  return {
    folder: data?.pages[0]?.folder ?? null,
    folders: data?.pages.flatMap((p) => p.subfolders.items) ?? [],
    files: data?.pages.flatMap((p) => p.files.items) ?? [],
    isLoading: query.isLoading,
    error: query.error,
    hasNextPage: query.hasNextPage ?? false,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
  }
}
