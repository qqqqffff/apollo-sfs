// Types for the inbound email feature (SendGrid Inbound Parse → admin console).
// Mirror the Go response shapes in api/models/inbound_email.go.

// EmailWorker is one service mailbox plus its message counts, used to render the
// worker sidebar and unread badges.
export interface EmailWorker {
  worker_name: string
  total_count: number
  unread_count: number
}

// EmailMeta is the queryable index row returned by the list endpoint. The
// server-side file path is intentionally never exposed.
export interface EmailMeta {
  id: string
  worker_name: string
  message_id?: string
  from_addr: string
  to_addr: string
  subject: string
  has_attachments: boolean
  read: boolean
  received_at: string
}

// EmailAttachment metadata; content_base64 holds the inline bytes.
export interface EmailAttachment {
  filename: string
  content_type: string
  size: number
  content_base64?: string
}

// StoredEmail is the full message persisted on disk and returned with the detail.
export interface StoredEmail {
  message_id: string
  from: string
  to: string
  subject: string
  date: string
  text: string
  html: string
  headers: string
  attachments: EmailAttachment[]
}

// EmailDetail combines the index row with the full on-disk message.
export interface EmailDetail extends EmailMeta {
  message: StoredEmail
}
