package models

import (
	"time"

	"github.com/google/uuid"
)

// CollectionItem mirrors the `collection_items` table. It is a pointer placing a
// file into a media subcollection without changing the file's physical home
// (files.folder_id). A single file may have pointers in multiple subcollections.
type CollectionItem struct {
	ID           uuid.UUID `json:"id" db:"id"`
	UserID       uuid.UUID `json:"user_id" db:"user_id"`
	CollectionID uuid.UUID `json:"collection_id" db:"collection_id"`
	FileID       uuid.UUID `json:"file_id" db:"file_id"`
	CreatedAt    time.Time `json:"created_at" db:"created_at"`
}
