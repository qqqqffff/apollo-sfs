package models

import (
	"time"

	"github.com/google/uuid"
)

// InterestSubmission mirrors the `interest_submissions` table.
type InterestSubmission struct {
	ID               uuid.UUID  `json:"id"`
	Name             string     `json:"name"`
	Email            string     `json:"email"`
	DesiredStorageGB int        `json:"desired_storage_gb"`
	UseCase          string     `json:"use_case"`
	IPAddress        string     `json:"ip_address"`
	CreatedAt        time.Time  `json:"created_at"`
	ProvisionedAt    *time.Time `json:"provisioned_at"`
	InvitationID     *uuid.UUID `json:"invitation_id"`
}

// InterestFormSettings mirrors the `interest_form_settings` table (single row).
type InterestFormSettings struct {
	DailyCap  int       `json:"daily_cap"`
	UpdatedAt time.Time `json:"updated_at"`
}
