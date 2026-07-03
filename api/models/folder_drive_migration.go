package models

import (
	"time"

	"github.com/google/uuid"
)

const (
	FolderDriveMigrationStatusPending    = "pending"
	FolderDriveMigrationStatusInProgress = "in_progress"
	FolderDriveMigrationStatusCompleted  = "completed"
	FolderDriveMigrationStatusFailed     = "failed"
)

// FolderDriveMigration mirrors the folder_drive_migrations table. Each row
// tracks one tier/server-change job for a folder's direct files, and also
// serves as the rate-limit ledger (rows created within the trailing 30 days
// are counted against the per-folder limit — see folder_drive_migration.go
// in routes/services).
type FolderDriveMigration struct {
	ID           uuid.UUID  `json:"id"`
	FolderID     uuid.UUID  `json:"folder_id"`
	UserID       uuid.UUID  `json:"-"`
	FromDriveID  *uuid.UUID `json:"from_drive_id"`
	ToDriveID    uuid.UUID  `json:"to_drive_id"`
	Status       string     `json:"status"`
	TotalFiles   int        `json:"total_files"`
	FilesMoved   int        `json:"files_moved"`
	TotalBytes   int64      `json:"total_bytes"`
	BytesMoved   int64      `json:"bytes_moved"`
	ErrorMessage *string    `json:"error_message,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	CompletedAt  *time.Time `json:"completed_at,omitempty"`
}
