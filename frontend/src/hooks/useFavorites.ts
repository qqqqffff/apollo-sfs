import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  favoritesQueryOptions,
  favoriteFile,
  unfavoriteFile,
  favoriteFolder,
  unfavoriteFolder,
} from '../api/favorites'
import type { FavoriteList } from '../types/api'

export function useFavorites() {
  const queryClient = useQueryClient()
  const { data } = useQuery(favoritesQueryOptions)

  const favoriteFileIds = new Set(data?.files.map((f) => f.id) ?? [])
  const favoriteFolderIds = new Set(data?.folders.map((f) => f.id) ?? [])

  function optimisticToggle(
    updater: (prev: FavoriteList) => FavoriteList,
  ) {
    const prev = queryClient.getQueryData<FavoriteList>(favoritesQueryOptions.queryKey)
    if (prev) {
      queryClient.setQueryData(favoritesQueryOptions.queryKey, updater(prev))
    }
    return prev
  }

  const addFileMutation = useMutation({
    mutationFn: favoriteFile,
    onMutate: () => {
      // We don't have the full File object here so we just invalidate after.
      return optimisticToggle((prev) => prev) // no-op optimistic; invalidate on settle
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: favoritesQueryOptions.queryKey }),
  })

  const removeFileMutation = useMutation({
    mutationFn: unfavoriteFile,
    onMutate: (fileId) =>
      optimisticToggle((prev) => ({
        ...prev,
        files: prev.files.filter((f) => f.id !== fileId),
      })),
    onError: (_err, _fileId, prev) => {
      if (prev) queryClient.setQueryData(favoritesQueryOptions.queryKey, prev)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: favoritesQueryOptions.queryKey }),
  })

  const addFolderMutation = useMutation({
    mutationFn: favoriteFolder,
    onSettled: () => queryClient.invalidateQueries({ queryKey: favoritesQueryOptions.queryKey }),
  })

  const removeFolderMutation = useMutation({
    mutationFn: unfavoriteFolder,
    onMutate: (folderId) =>
      optimisticToggle((prev) => ({
        ...prev,
        folders: prev.folders.filter((f) => f.id !== folderId),
      })),
    onError: (_err, _folderId, prev) => {
      if (prev) queryClient.setQueryData(favoritesQueryOptions.queryKey, prev)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: favoritesQueryOptions.queryKey }),
  })

  function toggleFile(fileId: string) {
    if (favoriteFileIds.has(fileId)) {
      removeFileMutation.mutate(fileId)
    } else {
      addFileMutation.mutate(fileId)
    }
  }

  function toggleFolder(folderId: string) {
    if (favoriteFolderIds.has(folderId)) {
      removeFolderMutation.mutate(folderId)
    } else {
      addFolderMutation.mutate(folderId)
    }
  }

  return { favoriteFileIds, favoriteFolderIds, toggleFile, toggleFolder }
}
