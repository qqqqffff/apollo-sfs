export interface User {
  username: string
  email: string
  storage_used_bytes: number
  storage_quota_bytes: number
  last_seen_at: string | null
  created_at: string
  is_admin: boolean
  is_premium: boolean
  premium_granted_at: string | null
  active_ban?: UserBan | null
  linked_providers: string[]
}

export type APIKeyOperation = 'read' | 'write' | 'delete' | 'list'

export interface APIKeyScope {
  id?: string
  operation: APIKeyOperation
  path_prefix: string
}

export interface APIKey {
  id: string
  username: string
  name: string
  key_prefix: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
  scopes?: APIKeyScope[]
  matching_operations?: APIKeyOperation[]
}

export interface IssuedAPIKey {
  raw_key: string
  key: APIKey
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

// MathGameScore mirrors a row in the backend `math_game_scores` table: one
// completed game of the /math-game mental-math test for the signed-in user.
export interface MathGameScore {
  id: string
  username: string
  score: number
  total: number
  duration_ms: number
  created_at: string
}

export type FolderKind = 'regular' | 'media'

export interface Folder {
  id: string
  user_id: string
  parent_id: string | null
  name: string
  kind: FolderKind
  // Recursive sum of all file sizes under this folder. Populated by listing
  // endpoints; 0 on bare single-folder responses (create/rename/move).
  size_bytes: number
  // Optional pin to a specific drive for this folder's direct uploads. Null
  // means dynamic primary-first/least-full routing (today's default behavior).
  drive_id: string | null
  created_at: string
  updated_at: string
}

export type FolderDriveMigrationStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

// FolderDriveMigration tracks a single job moving a folder's direct files
// from one drive to another (potentially across servers/tiers).
export interface FolderDriveMigration {
  id: string
  folder_id: string
  status: FolderDriveMigrationStatus
  total_files: number
  files_moved: number
  total_bytes: number
  bytes_moved: number
  error_message: string | null
  created_at: string
  completed_at: string | null
}

// DriveMigrationEligibility bundles the most recent migration for a folder
// with rate-limit bookkeeping (3 changes per folder per rolling 30 days).
export interface DriveMigrationEligibility {
  migration: FolderDriveMigration | null
  recent_count: number
  limit: number
  window_days: number
  next_eligible_at: string | null
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
  grant_premium: boolean
  invitation_url?: string
}

// Share mirrors the backend ShareInfo: a grant giving one recipient (matched
// by account email) access to a single file or a folder subtree.
export interface Share {
  id: string
  owner_user_id: string
  recipient_email: string
  file_id: string | null
  folder_id: string | null
  // Files: recipient may download (viewing is always allowed).
  // Folders: recipient may download contained files.
  can_download: boolean
  // Folders only: recipient may upload into the folder.
  can_upload: boolean
  // Folders only: the share covers all descendant folders.
  include_children: boolean
  revoked_at: string | null
  created_at: string
  item_type: 'file' | 'folder'
  item_name: string
  item_size_bytes: number
  item_mime_type?: string
  // Present on recipient-facing listings.
  owner_email?: string
  share_url: string
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

export interface ServerExpansionRequest {
  id: string
  username: string
  server_id: string
  plan_id: string
  storage_type: 'nvme' | 'hdd'
  bytes_requested: number
  deposit_amount_cents: number
  full_price_cents: number
  currency: string
  payment_method: string
  paypal_order_id: string
  paypal_capture_id: string | null
  status: 'opened' | 'expanded' | 'completed' | 'expired' | 'refunded'
  pre_quota_bytes: number
  post_quota_bytes: number | null
  expires_at: string
  created_at: string
  completed_at: string | null
  refund_id: string | null
  cancellation_reason: string | null
  payment_due_at: string | null
  server_name: string
  server_state: string
  user_email: string
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
