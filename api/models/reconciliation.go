package models

import (
	"time"

	"github.com/google/uuid"
)

// Reconciliation finding kinds.
const (
	ReconciliationKindOrphanObject       = "orphan_object"
	ReconciliationKindGhostFileRow       = "ghost_file_row"
	ReconciliationKindGhostVariantRow    = "ghost_variant_row"
	ReconciliationKindGhostRecognition   = "ghost_recognition_crop"
	ReconciliationKindAbandonedMultipart = "abandoned_multipart"
)

// Reconciliation finding actions.
const (
	ReconciliationActionDeleted = "deleted"
	ReconciliationActionAborted = "aborted"
	ReconciliationActionError   = "error"
)

// ReconciliationRun is one scan of MinIO object storage against the Postgres
// files/video_variants/recognition_detections rows that should reference it —
// either the daily 4am-local heartbeat or an admin-triggered manual run.
type ReconciliationRun struct {
	ID                      uuid.UUID  `json:"id"`
	StartedAt               time.Time  `json:"started_at"`
	FinishedAt              *time.Time `json:"finished_at,omitempty"`
	DrivesScanned           int        `json:"drives_scanned"`
	ObjectsScanned          int        `json:"objects_scanned"`
	RowsScanned             int        `json:"rows_scanned"`
	OrphansFound            int        `json:"orphans_found"`
	OrphansDeleted          int        `json:"orphans_deleted"`
	GhostsFound             int        `json:"ghosts_found"`
	GhostsDeleted           int        `json:"ghosts_deleted"`
	AbandonedUploadsAborted int        `json:"abandoned_uploads_aborted"`
	Error                   *string    `json:"error,omitempty"`
}

// ReconciliationFinding is one piece of drift discovered by a run: an object in
// MinIO with no referencing DB row (orphan), a DB row referencing an object
// that no longer exists (ghost), or an abandoned incomplete multipart upload.
// RunID is nullable so findings logged outside of a scheduled scan (e.g. a
// failed drive-migration cleanup) still surface in the admin ledger.
type ReconciliationFinding struct {
	ID        uuid.UUID  `json:"id"`
	RunID     *uuid.UUID `json:"run_id,omitempty"`
	Kind      string     `json:"kind"`
	DriveID   *uuid.UUID `json:"drive_id,omitempty"`
	Bucket    string     `json:"bucket,omitempty"`
	ObjectKey string     `json:"object_key,omitempty"`
	UserID    *uuid.UUID `json:"user_id,omitempty"`
	FileID    *uuid.UUID `json:"file_id,omitempty"`
	Detail    string     `json:"detail,omitempty"`
	Action    string     `json:"action"`
	Error     *string    `json:"error,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}
