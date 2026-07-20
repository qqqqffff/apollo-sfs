package models

import (
	"time"

	"github.com/google/uuid"
)

// Folder mirrors the `folders` table. The folder hierarchy is virtual — it
// exists only in PostgreSQL; MinIO has no knowledge of it.
// Unique constraint: (user_id, parent_id, name).
type Folder struct {
	ID       uuid.UUID  `json:"id" db:"id"`
	UserID   uuid.UUID  `json:"user_id" db:"user_id"`
	ParentID *uuid.UUID `json:"parent_id" db:"parent_id"` // NULL means root folder
	// DriveID optionally pins uploads into this folder to a specific drive,
	// overriding the dynamic primary-first/least-full routing. NULL preserves
	// today's behavior exactly.
	DriveID *uuid.UUID `json:"drive_id" db:"drive_id"`
	Name    string     `json:"name" db:"name"`
	// Kind is "regular", "media", or "email". A media folder is a top-level
	// picture/video collection; folders nested beneath it act as
	// subcollections. An email folder holds a provider mailbox backup (its
	// name is the backed-up email address) and renders as a mail viewer.
	Kind string `json:"kind" db:"kind"`
	// AIRecognitionEnabled turns on premium AI face/pet/object indexing for a
	// media collection. Only meaningful when Kind == "media".
	AIRecognitionEnabled bool `json:"ai_recognition_enabled" db:"ai_recognition_enabled"`
	// SizeBytes is the recursive sum of all file sizes under the folder
	// (including descendants). Computed by the listing queries; 0 on bare
	// inserts/updates that don't compute it.
	SizeBytes int64     `json:"size_bytes" db:"size_bytes"`
	CreatedAt time.Time `json:"created_at" db:"created_at"`
	UpdatedAt time.Time `json:"updated_at" db:"updated_at"`
}

// Folder kind values.
const (
	FolderKindRegular = "regular"
	FolderKindMedia   = "media"
	FolderKindEmail   = "email"
)
