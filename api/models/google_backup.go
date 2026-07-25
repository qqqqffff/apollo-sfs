package models

import (
	"time"

	"github.com/google/uuid"
)

// GoogleBackupRun mirrors the `google_backup_runs` table: one completed
// Google Drive/Photos backup run (foreground or background). Rows with
// Notify = true back the notification bell's "google backup completed" items
// — see EmailBackupRun for the equivalent on the email backup side.
type GoogleBackupRun struct {
	ID          uuid.UUID `json:"id"`
	Username    string    `json:"-"`
	UserID      uuid.UUID `json:"-"`
	Uploaded    int       `json:"uploaded"`
	Duplicates  int       `json:"duplicates"`
	Errors      int       `json:"errors"`
	Notify      bool      `json:"notify"`
	CompletedAt time.Time `json:"completed_at"`
}
