export interface User {
  username: string
  email: string
  storage_used_bytes: number
  storage_quota_bytes: number
  last_seen_at: string | null
  created_at: string
  is_admin: boolean
}

export interface File {
  id: string
  user_id: string
  folder_id: string
  name: string
  mime_type: string
  size_bytes: number
  created_at: string
  updated_at: string
}

export interface Folder {
  id: string
  user_id: string
  parent_id: string | null
  name: string
  created_at: string
  updated_at: string
}

export interface FolderContents {
  folder: Folder | null
  subfolders: PageResult<Folder>
  files: PageResult<File>
}

export interface PageResult<T> {
  items: T[]
  next_token: string
}

export interface Invitation {
  id: string
  invited_by_user_id: string
  email: string
  token_expires_at: string
  accepted_at: string | null
  revoked_at: string | null
  created_at: string
}

export interface UploadResponse {
  id: string
  name: string
  mime_type: string
  size_bytes: number
  folder_id: string
}

export interface FavoriteList {
  files: File[]
  folders: Folder[]
}
