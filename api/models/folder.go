package models

import (
	"time"

	"github.com/google/uuid"
)

// Folder mirrors the `folders` table. The folder hierarchy is virtual — it
// exists only in PostgreSQL; MinIO has no knowledge of it.
// Unique constraint: (user_id, parent_id, name).
type Folder struct {
	ID        uuid.UUID  `json:"id" db:"id"`
	UserID    uuid.UUID  `json:"user_id" db:"user_id"`
	ParentID  *uuid.UUID `json:"parent_id" db:"parent_id"` // NULL means root folder
	Name      string     `json:"name" db:"name"`
	CreatedAt time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt time.Time  `json:"updated_at" db:"updated_at"`
}
