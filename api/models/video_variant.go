package models

import (
	"time"

	"github.com/google/uuid"
)

const (
	VideoVariantStatusPending = "pending"
	VideoVariantStatusReady   = "ready"
	VideoVariantStatusFailed  = "failed"
)

// VideoVariant mirrors the video_variants table. Each row is a transcoded
// derivative of a File (e.g. a 480p H.264/AAC MP4 stored in MinIO).
// Rows are cascade-deleted when the parent files row is removed.
type VideoVariant struct {
	ID             uuid.UUID `json:"id"`
	FileID         uuid.UUID `json:"file_id"`
	Quality        string    `json:"quality"`
	MinIOObjectKey string    `json:"-"`
	SizeBytes      int64     `json:"size_bytes"`
	Status         string    `json:"status"`
	CreatedAt      time.Time `json:"created_at"`
}
