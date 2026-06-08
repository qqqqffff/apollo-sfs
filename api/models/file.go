package models

import (
	"time"

	"github.com/google/uuid"
)

// File mirrors the `files` table. The encrypted blob lives in MinIO at
// minio_object_key; nonce is the AES-GCM nonce used to encrypt it.
// Unique constraint: (user_id, folder_id, name).
type File struct {
	ID             uuid.UUID  `json:"id" db:"id"`
	UserID         uuid.UUID  `json:"user_id" db:"user_id"`
	FolderID       *uuid.UUID `json:"folder_id" db:"folder_id"`
	DriveID        *uuid.UUID `json:"-" db:"drive_id"`
	Name           string     `json:"name" db:"name"`
	MimeType       string     `json:"mime_type" db:"mime_type"`
	SizeBytes      int64      `json:"size_bytes" db:"size_bytes"`
	MinIOObjectKey string     `json:"-" db:"minio_object_key"`
	Nonce          []byte     `json:"-" db:"nonce"`
	// TakenAt is the capture date from media metadata (EXIF/container). Nil when
	// unavailable; clients sort media by TakenAt, falling back to CreatedAt.
	TakenAt *time.Time `json:"taken_at" db:"taken_at"`
	// SHA256Hash is the hex-encoded SHA-256 of the plaintext bytes. Used by mobile
	// clients for dedup: check before uploading identical content.
	SHA256Hash *string `json:"sha256_hash,omitempty" db:"sha256_hash"`
	// Hidden excludes the file from collection listings unless explicitly shown.
	Hidden    bool      `json:"hidden" db:"hidden"`
	CreatedAt time.Time `json:"created_at" db:"created_at"`
	UpdatedAt time.Time `json:"updated_at" db:"updated_at"`
}
