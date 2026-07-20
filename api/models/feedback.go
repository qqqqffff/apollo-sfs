package models

import (
	"time"

	"github.com/google/uuid"
)

// Feedback mirrors the `feedback` table: a free-text submission from a user,
// triaged by admins via the admin review page.
type Feedback struct {
	ID        uuid.UUID `json:"id" db:"id"`
	UserID    uuid.UUID `json:"user_id" db:"user_id"`
	Username  string    `json:"username" db:"username"`
	Category  string    `json:"category" db:"category"` // "bug" | "feature" | "general"
	Message   string    `json:"message" db:"message"`
	Status    string    `json:"status" db:"status"` // "new" | "reviewed" | "archived"
	CreatedAt time.Time `json:"created_at" db:"created_at"`
	UpdatedAt time.Time `json:"updated_at" db:"updated_at"`
}
