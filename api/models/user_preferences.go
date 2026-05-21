package models

import (
	"time"

	"github.com/google/uuid"
)

// UserPreferences mirrors the `user_preferences` table — one row per user,
// created lazily on first write. UserID is the Keycloak subject (stored as TEXT).
type UserPreferences struct {
	UserID string `json:"user_id" db:"user_id"`
	// MediaAutouploadFolderID, when set, routes every image/video upload into
	// that media folder automatically regardless of the requested target folder.
	MediaAutouploadFolderID *uuid.UUID `json:"media_autoupload_folder_id" db:"media_autoupload_folder_id"`
	CreatedAt               time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt               time.Time  `json:"updated_at" db:"updated_at"`
}
