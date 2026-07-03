package models

import (
	"time"

	"github.com/google/uuid"
)

// Share mirrors the `shares` table: a grant giving one recipient (identified
// by email) access to a single file or a folder subtree owned by another user.
// Exactly one of FileID / FolderID is set (CHECK constraint shares_one_target).
//
// OwnerUserID is the Keycloak subject UUID (matches files.user_id); OwnerUsername
// is the users-table key (preferred_username) needed for key decryption and
// quota accounting — the same dual identity carried by presign claims.
type Share struct {
	ID            uuid.UUID `json:"id" db:"id"`
	Token         string    `json:"-" db:"token"` // raw link token; exposed only via ShareURL
	OwnerUserID   uuid.UUID `json:"owner_user_id" db:"owner_user_id"`
	OwnerUsername string    `json:"-" db:"owner_username"`
	// RecipientEmail is stored lowercased; access checks compare it against the
	// logged-in user's account email case-insensitively.
	RecipientEmail string     `json:"recipient_email" db:"recipient_email"`
	FileID         *uuid.UUID `json:"file_id" db:"file_id"`
	FolderID       *uuid.UUID `json:"folder_id" db:"folder_id"`
	// CanDownload: file shares — sharee may download the file (viewing is always
	// allowed); folder shares — sharee may download contained files.
	CanDownload bool `json:"can_download" db:"can_download"`
	// CanUpload applies to folder shares only: sharee may upload into the folder.
	CanUpload bool `json:"can_upload" db:"can_upload"`
	// IncludeChildren applies to folder shares only: the share covers all
	// descendant folders rather than just the folder's direct files.
	IncludeChildren bool       `json:"include_children" db:"include_children"`
	RevokedAt       *time.Time `json:"revoked_at" db:"revoked_at"`
	CreatedAt       time.Time  `json:"created_at" db:"created_at"`
}
