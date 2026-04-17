package models

import (
	"time"

	"github.com/google/uuid"
)

// File mirrors the `files` table. The encrypted blob lives in MinIO at
// minio_object_key; nonce is the AES-GCM nonce used to encrypt it.
// Unique constraint: (user_id, folder_id, name).
type File struct {
	ID             uuid.UUID `json:"id" db:"id"`
	UserID         uuid.UUID `json:"user_id" db:"user_id"`
	FolderID       uuid.UUID `json:"folder_id" db:"folder_id"`
	Name           string    `json:"name" db:"name"`
	MimeType       string    `json:"mime_type" db:"mime_type"`
	SizeBytes      int64     `json:"size_bytes" db:"size_bytes"`
	MinIOObjectKey string    `json:"-" db:"minio_object_key"`
	Nonce          []byte    `json:"-" db:"nonce"`
	CreatedAt      time.Time `json:"created_at" db:"created_at"`
	UpdatedAt      time.Time `json:"updated_at" db:"updated_at"`
}
