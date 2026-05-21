export interface User {
  username: string
  email: string
  storage_used_bytes: number
  storage_quota_bytes: number
  last_seen_at: string | null
  created_at: string
  is_admin: boolean
  active_ban?: UserBan | null
}

export interface File {
  id: string
  user_id: string
  folder_id: string | null
  name: string
  mime_type: string
  size_bytes: number
  // Capture date from media metadata (EXIF/container); null when unavailable.
  taken_at: string | null
  // Hidden files are excluded from collection views unless explicitly shown.
  hidden: boolean
  created_at: string
  updated_at: string
  // Only present on the single-file GET endpoint; undefined in list responses.
  has_low_variant?: boolean
}

export type FolderKind = 'regular' | 'media'

export interface Folder {
  id: string
  user_id: string
  parent_id: string | null
  name: string
  kind: FolderKind
  created_at: string
  updated_at: string
}

export interface UserPreferences {
  user_id: string
  media_autoupload_folder_id: string | null
  created_at: string
  updated_at: string
}

export type MediaSort = 'taken_at' | 'created_at' | 'name'
export type HiddenMode = 'hide' | 'show' | 'only'

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
  initial_quota_bytes: number
  grant_admin: boolean
  invitation_url?: string
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

export interface InterestSubmission {
  id: string
  name: string
  email: string
  desired_storage_gb: number
  use_case: string
  ip_address: string
  created_at: string
  provisioned_at: string | null
  invitation_id: string | null
}

export interface InterestFormSettings {
  daily_cap: number
  updated_at: string
}

export interface BannedIP {
  id: number
  ip: string
  jail: string
  banned_at: string
  unbanned_at: string | null
  ban_count: number
  country: string
  city: string
}

export interface AuditLog {
  id: string
  target_username: string
  actor_username: string
  action: string
  resource_type: string | null
  resource_id: string | null
  resource_name: string | null
  created_at: string
}

export type BanType = 'banned' | 'suspended'

export interface UserBan {
  id: number
  username: string
  ban_type: BanType
  violation_code: string
  comments: string
  banned_by: string
  banned_at: string
  expires_at: string | null
  pardoned_at: string | null
  pardoned_by: string | null
}

export interface AccountRestriction {
  error: 'banned' | 'suspended'
  violation_code: string
  comments: string
  banned_at: string
  expires_at?: string | null
}

export const VIOLATION_CODES: Record<string, string> = {
  illegal_activity:    'Illegal or fraudulent activity (§4)',
  third_party_rights:  'Violation of third-party rights (§4)',
  violence_harm:       'Violence and serious harm (§4)',
  child_exploitation:  'Child exploitation (§4)',
  system_attacks:      'System attacks (§4)',
  spam:                'Unsolicited bulk communications (§4)',
  reverse_engineering: 'Reverse engineering or circumvention (§4)',
  unauthorized_resale: 'Unauthorized resale or redistribution (§4)',
  security_risk:       'Security risk to service or users (§6)',
  material_breach:     'Material breach of agreement (§6)',
  other:               'Other / unspecified reason',
}
