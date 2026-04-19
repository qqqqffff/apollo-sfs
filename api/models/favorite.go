package models

import (
	"time"

	"github.com/google/uuid"
)

// Favorite mirrors the `favorites` table. Exactly one of FileID and FolderID
// is non-nil on any given row (enforced by a DB CHECK constraint).
type Favorite struct {
	ID        uuid.UUID  `json:"id" db:"id"`
	UserID    uuid.UUID  `json:"user_id" db:"user_id"`
	FileID    *uuid.UUID `json:"file_id" db:"file_id"`
	FolderID  *uuid.UUID `json:"folder_id" db:"folder_id"`
	CreatedAt time.Time  `json:"created_at" db:"created_at"`
}
