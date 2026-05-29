import { get, post, del } from './client'
import type { APIKey, APIKeyScope, IssuedAPIKey } from '../types/api'

export interface CreateAPIKeyInput {
  name: string
  scopes: APIKeyScope[]
  ttl_days?: number
}

// listAPIKeys returns the current user's keys. Passing `path` populates
// matching_operations per key — used by the share-directory modal so the
// list can show which keys cover the folder being shared.
export function listAPIKeys(path?: string): Promise<{ items: APIKey[] }> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : ''
  return get<{ items: APIKey[] }>('/me/api-keys' + qs)
}

export function createAPIKey(input: CreateAPIKeyInput): Promise<IssuedAPIKey> {
  return post<IssuedAPIKey>('/me/api-keys', input)
}

export function revokeAPIKey(id: string): Promise<void> {
  return del<void>('/me/api-keys/' + id)
}
