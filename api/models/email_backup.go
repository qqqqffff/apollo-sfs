package models

import (
	"time"

	"github.com/google/uuid"
)

// Email backup provider values.
const (
	EmailBackupProviderGmail     = "gmail"
	EmailBackupProviderMicrosoft = "microsoft"
)

// EmailBackupMessage mirrors the `email_backup_messages` table. It is the
// queryable index for a message whose full content (a StoredEmail JSON
// document) lives as a regular encrypted file referenced by FileID. Only the
// metadata needed to render the viewer's list pane is duplicated here.
type EmailBackupMessage struct {
	ID                uuid.UUID `json:"id"`
	UserID            uuid.UUID `json:"-"`
	FolderID          uuid.UUID `json:"folder_id"`
	FileID            uuid.UUID `json:"file_id"`
	Provider          string    `json:"provider"`
	ProviderMessageID string    `json:"provider_message_id"`
	FromAddr          string    `json:"from_addr"`
	ToAddr            string    `json:"to_addr"`
	Subject           string    `json:"subject"`
	Snippet           string    `json:"snippet"`
	HasAttachments    bool      `json:"has_attachments"`
	Starred           bool      `json:"starred"`
	Read              bool      `json:"read"`
	ReceivedAt        time.Time `json:"received_at"`
	CreatedAt         time.Time `json:"created_at"`

	// Name and size of the encrypted file the message was stored as. Not
	// columns of email_backup_messages — set only on the response to
	// POST /email-backup/messages, so a running backup can show the file it
	// just wrote (folder + name) and add its bytes to the quota bar without
	// re-reading the whole listing. Omitted everywhere else.
	FileName      string `json:"file_name,omitempty"`
	FileSizeBytes int64  `json:"file_size_bytes,omitempty"`
}

// EmailBackupMessageDetail combines the index row with the decrypted on-file
// message body. Returned by the GET /email-backup/messages/:id endpoint —
// same shape family as the admin panel's EmailDetail so the frontend viewer
// can share rendering code.
type EmailBackupMessageDetail struct {
	EmailBackupMessage
	Message StoredEmail `json:"message"`
}

// EmailBackupSenderSummary is one row of the viewer's sender sidebar: a
// distinct from_addr in the backup folder plus its total and unread counts
// (mirrors WorkerSummary in the admin inbound-email panel).
type EmailBackupSenderSummary struct {
	FromAddr    string `json:"from_addr"`
	TotalCount  int    `json:"total_count"`
	UnreadCount int    `json:"unread_count"`
}

// EmailBackupRecipientSummary is the to_addr counterpart of
// EmailBackupSenderSummary — one row per distinct to_addr in the backup
// folder, backing the viewer's mobile "group by recipient" toggle.
type EmailBackupRecipientSummary struct {
	ToAddr      string `json:"to_addr"`
	TotalCount  int    `json:"total_count"`
	UnreadCount int    `json:"unread_count"`
}

// EmailBackupRun mirrors the `email_backup_runs` table: one completed backup
// run. Rows with Notify = true back the notification bell's
// "email backup completed" items.
type EmailBackupRun struct {
	ID           uuid.UUID  `json:"id"`
	Username     string     `json:"-"`
	UserID       uuid.UUID  `json:"-"`
	FolderID     *uuid.UUID `json:"folder_id"`
	EmailAddress string     `json:"email_address"`
	Provider     string     `json:"provider"`
	Uploaded     int        `json:"uploaded"`
	Duplicates   int        `json:"duplicates"`
	Errors       int        `json:"errors"`
	Notify       bool       `json:"notify"`
	CompletedAt  time.Time  `json:"completed_at"`
}
