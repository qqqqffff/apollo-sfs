import { get, post, patch, del } from './client'

// A premium file-server mount link. mount_url is the WebDAV address the user
// mounts as a network drive; connecting always additionally requires their
// Apollo SFS login credentials.
export interface FileServerLink {
  id: string
  server_id: string
  server_name: string
  enhanced_security: boolean
  created_at: string
  last_used_at: string | null
  mount_url: string
}

export interface CreateFileServerLinkResult {
  link: FileServerLink
  // false when a link already existed for the chosen server — the UI shows
  // the existing link instead of a success state.
  created: boolean
}

export function listFileServerLinks(): Promise<{ items: FileServerLink[] }> {
  return get<{ items: FileServerLink[] }>('/me/file-server-links')
}

export function createFileServerLink(serverId: string, enhancedSecurity: boolean): Promise<CreateFileServerLinkResult> {
  return post<CreateFileServerLinkResult>('/me/file-server-links', {
    server_id: serverId,
    enhanced_security: enhancedSecurity,
  })
}

export function updateFileServerLink(id: string, enhancedSecurity: boolean): Promise<void> {
  return patch<void>('/me/file-server-links/' + id, { enhanced_security: enhancedSecurity })
}

export function deleteFileServerLink(id: string): Promise<void> {
  return del<void>('/me/file-server-links/' + id)
}

export function verifyFileServerLocation(token: string): Promise<{ verified: boolean }> {
  return post<{ verified: boolean }>('/me/file-server-links/verify-location', { token })
}
