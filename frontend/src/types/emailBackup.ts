// Types for the email backup feature (provider mailbox → encrypted files in an
// 'email' folder). Mirror the Go response shapes in api/models/email_backup.go.

import type { StoredEmail } from './inboundEmail'

export type { StoredEmail }

// EmailBackupMessage is the queryable index row returned by the list endpoint.
// The full message lives in the encrypted file referenced by file_id.
export interface EmailBackupMessage {
  id: string
  folder_id: string
  file_id: string
  provider: 'gmail' | 'microsoft'
  provider_message_id: string
  from_addr: string
  to_addr: string
  subject: string
  snippet: string
  has_attachments: boolean
  starred: boolean
  read: boolean
  received_at: string
  created_at: string
  // Set only on the POST /email-backup/messages response: the encrypted file
  // the message was just written to. Lets a running backup show the file's
  // path and credit its bytes to the quota bar without re-reading the folder.
  file_name?: string
  file_size_bytes?: number
}

// EmailBackupDetail combines the index row with the decrypted full message —
// same shape family as the admin panel's EmailDetail, so the viewer renders
// them identically.
export interface EmailBackupDetail extends EmailBackupMessage {
  message: StoredEmail
}

// EmailBackupSender is one row of the viewer's sender sidebar.
export interface EmailBackupSender {
  from_addr: string
  total_count: number
  unread_count: number
}

// EmailBackupRecipient is the to_addr counterpart of EmailBackupSender —
// backs the mobile viewer's "group by recipient" toggle.
export interface EmailBackupRecipient {
  to_addr: string
  total_count: number
  unread_count: number
}

// EmailBackupRun is the completed-run record returned by POST /email-backup/runs.
export interface EmailBackupRun {
  id: string
  folder_id: string | null
  email_address: string
  provider: string
  uploaded: number
  duplicates: number
  errors: number
  notify: boolean
  completed_at: string
}
