package models

import (
	"time"

	"github.com/google/uuid"
)

// Recognition job statuses.
const (
	RecognitionJobPending    = "pending"
	RecognitionJobProcessing = "processing"
	RecognitionJobDone       = "done"
	RecognitionJobFailed     = "failed"
	RecognitionJobSkipped    = "skipped"
)

// Recognition detection/group kinds.
const (
	RecognitionKindFace   = "face"
	RecognitionKindPet    = "pet"
	RecognitionKindObject = "object"
)

// RecognitionJob mirrors the recognition_jobs table — the durable per-file
// work queue for AI indexing. Username duplicates the users PK (needed for
// key unwrapping and quota accounting) alongside the UUID used for RLS.
type RecognitionJob struct {
	ID           uuid.UUID `json:"id"`
	UserID       uuid.UUID `json:"user_id"`
	Username     string    `json:"-"`
	CollectionID uuid.UUID `json:"collection_id"`
	FileID       uuid.UUID `json:"file_id"`
	Status       string    `json:"status"`
	Attempts     int       `json:"attempts"`
	Error        *string   `json:"error,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// RecognitionDetection mirrors the recognition_detections table. Detections
// are per-file and collection-agnostic: a file inferred once is only
// cluster-assigned (never re-inferred) for additional collections.
// Embedding is a unit-normalized little-endian float32 vector; nil for
// object detections. The bbox is normalized to [0,1] of the source frame.
// FrameMs is the keyframe timestamp for video files, nil for images.
type RecognitionDetection struct {
	ID             uuid.UUID `json:"id"`
	UserID         uuid.UUID `json:"user_id"`
	FileID         uuid.UUID `json:"file_id"`
	Kind           string    `json:"kind"`
	ClassLabel     *string   `json:"class_label,omitempty"`
	Confidence     float32   `json:"confidence"`
	BBoxX          float32   `json:"bbox_x"`
	BBoxY          float32   `json:"bbox_y"`
	BBoxW          float32   `json:"bbox_w"`
	BBoxH          float32   `json:"bbox_h"`
	FrameMs        *int      `json:"frame_ms,omitempty"`
	Embedding      []byte    `json:"-"`
	ThumbObjectKey *string   `json:"-"`
	ThumbNonce     []byte    `json:"-"`
	ThumbSizeBytes int64     `json:"-"`
	ModelVersion   string    `json:"model_version"`
	CreatedAt      time.Time `json:"created_at"`
}

// RecognitionGroup mirrors the recognition_groups table — a per-collection
// cluster of face/pet detections, or the single per-class bucket for object
// detections. AutoLabel is generated ("Person 3", "Pet 1 (cat)", "car");
// UserLabel is set when the user names the group and is what search matches.
// MemberCount is the centroid weight used by incremental clustering; display
// counts are computed by joining recognition_group_members.
type RecognitionGroup struct {
	ID               uuid.UUID  `json:"id"`
	UserID           uuid.UUID  `json:"user_id"`
	CollectionID     uuid.UUID  `json:"collection_id"`
	Kind             string     `json:"kind"`
	ClassLabel       *string    `json:"class_label,omitempty"`
	AutoLabel        string     `json:"auto_label"`
	UserLabel        *string    `json:"user_label,omitempty"`
	Centroid         []byte     `json:"-"`
	MemberCount      int        `json:"member_count"`
	CoverDetectionID *uuid.UUID `json:"cover_detection_id,omitempty"`
	// FileCount is populated by listing queries (COUNT(DISTINCT file_id) over
	// members); 0 on bare reads that don't compute it.
	FileCount int `json:"file_count"`
	// CoverFileID is populated by listing queries (first member file) as the
	// tile fallback for groups without a stored crop (object groups).
	CoverFileID *uuid.UUID `json:"cover_file_id,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}
