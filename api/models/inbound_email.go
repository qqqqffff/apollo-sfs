package models

import (
	"time"

	"github.com/google/uuid"
)

// InboundEmail mirrors the `inbound_emails` table. It is the queryable index
// for a message whose full content lives on disk at FilePath. FilePath is never
// serialized to API clients — it is an internal server path.
type InboundEmail struct {
	ID             uuid.UUID `json:"id"`
	WorkerName     string    `json:"worker_name"`
	MessageID      *string   `json:"message_id,omitempty"`
	FromAddr       string    `json:"from_addr"`
	ToAddr         string    `json:"to_addr"`
	Subject        string    `json:"subject"`
	FilePath       string    `json:"-"`
	HasAttachments bool      `json:"has_attachments"`
	Read           bool      `json:"read"`
	ReceivedAt     time.Time `json:"received_at"`
}

// StoredEmail is the full message persisted as JSON on disk under
// EMAIL_STORAGE_PATH/<worker_name>/<YYYY-MM>/<id>.json.
type StoredEmail struct {
	MessageID   string            `json:"message_id"`
	From        string            `json:"from"`
	To          string            `json:"to"`
	Subject     string            `json:"subject"`
	Date        time.Time         `json:"date"`
	Text        string            `json:"text"`
	HTML        string            `json:"html"`
	Headers     string            `json:"headers"`
	Attachments []EmailAttachment `json:"attachments"`
}

// EmailAttachment holds a single attachment's metadata and inline bytes.
// Content is base64-encoded so the message is a self-contained JSON document.
type EmailAttachment struct {
	Filename      string `json:"filename"`
	ContentType   string `json:"content_type"`
	Size          int    `json:"size"`
	ContentBase64 string `json:"content_base64,omitempty"`
}

// EmailDetail combines the index row with the on-disk message body. Returned by
// the GET /admin/emails/:id endpoint.
type EmailDetail struct {
	InboundEmail
	Message StoredEmail `json:"message"`
}

// WorkerSummary is one row of the workers list: a service mailbox plus its
// total and unread message counts, used to render the worker sidebar + badges.
type WorkerSummary struct {
	WorkerName  string `json:"worker_name"`
	TotalCount  int    `json:"total_count"`
	UnreadCount int    `json:"unread_count"`
}
