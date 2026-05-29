package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type EmailStatus string

const (
	EmailStatusPending EmailStatus = "pending"
	EmailStatusSent    EmailStatus = "sent"
	EmailStatusFailed  EmailStatus = "failed"
)

// EmailQueue mirrors the `email_queue` table.
// template_data is stored as raw JSON and passed to the template renderer at
// send time. Max 3 send attempts before status is set to EmailStatusFailed.
type EmailQueue struct {
	ID           uuid.UUID       `json:"id" db:"id"`
	ToAddress    string          `json:"to_address" db:"to_address"`
	Subject      string          `json:"subject" db:"subject"`
	TemplateName string          `json:"template_name" db:"template_name"`
	TemplateData json.RawMessage `json:"template_data" db:"template_data"`
	Status       EmailStatus     `json:"status" db:"status"`
	Attempts     int             `json:"attempts" db:"attempts"`
	LastError    *string         `json:"last_error,omitempty" db:"last_error"`
	CreatedAt    time.Time       `json:"created_at" db:"created_at"`
	SentAt       *time.Time      `json:"sent_at" db:"sent_at"`
}
