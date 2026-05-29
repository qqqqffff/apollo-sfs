import { del, post, get } from './client'
import type { FavoriteList } from '../types/api'

export function getFavorites() {
  return get<FavoriteList>('/favorites')
}

export function favoriteFile(fileId: string) {
  return post<void>(`/favorites/files/${fileId}`, undefined)
}

export function unfavoriteFile(fileId: string) {
  return del<void>(`/favorites/files/${fileId}`)
}

export function favoriteFolder(folderId: string) {
  return post<void>(`/favorites/folders/${folderId}`, undefined)
}

export function unfavoriteFolder(folderId: string) {
  return del<void>(`/favorites/folders/${folderId}`)
}

export const favoritesQueryOptions = {
  queryKey: ['favorites'] as const,
  queryFn: getFavorites,
}
