package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"

	"apollo-sfs.com/api/models"
)

const recognitionJobColumns = `id, user_id, username, collection_id, file_id, status, attempts, error, created_at, updated_at`

const recognitionDetectionColumns = `
	id, user_id, file_id, kind, class_label, confidence,
	bbox_x, bbox_y, bbox_w, bbox_h, frame_ms, embedding,
	thumb_object_key, thumb_nonce, thumb_size_bytes, model_version, created_at`

const recognitionGroupColumns = `
	id, user_id, collection_id, kind, class_label, auto_label, user_label,
	centroid, member_count, cover_detection_id, created_at, updated_at`

// RecognitionJobCounts summarizes a collection's queue state per status.
type RecognitionJobCounts struct {
	Pending    int `json:"pending"`
	Processing int `json:"processing"`
	Done       int `json:"done"`
	Failed     int `json:"failed"`
	Skipped    int `json:"skipped"`
}

// RecognitionGroupSearchHit is one labeled-group match returned by the search
// endpoint alongside the existing folder/file lists.
type RecognitionGroupSearchHit struct {
	ID               uuid.UUID  `json:"id"`
	CollectionID     uuid.UUID  `json:"collection_id"`
	CollectionName   string     `json:"collection_name"`
	Kind             string     `json:"kind"`
	ClassLabel       *string    `json:"class_label,omitempty"`
	Label            string     `json:"label"`
	FileCount        int        `json:"file_count"`
	CoverDetectionID *uuid.UUID `json:"cover_detection_id,omitempty"`
	CoverFileID      *uuid.UUID `json:"cover_file_id,omitempty"`
}

// PurgedRecognitionCrop identifies one encrypted crop blob freed by a purge so
// the caller can delete it from MinIO and decrement the user's quota. DriveID
// (the source file's drive, where the crop lives) is nil for legacy files
// without a drive assignment.
type PurgedRecognitionCrop struct {
	ObjectKey string
	SizeBytes int64
	DriveID   *uuid.UUID
}

// RecognitionGroupCounts is the per-kind group tally shown by the status
// endpoint.
type RecognitionGroupCounts struct {
	Face   int `json:"face"`
	Pet    int `json:"pet"`
	Object int `json:"object"`
}

func scanRecognitionJob(rows *sql.Rows) (*models.RecognitionJob, error) {
	var j models.RecognitionJob
	var errMsg sql.NullString
	if err := rows.Scan(
		&j.ID, &j.UserID, &j.Username, &j.CollectionID, &j.FileID,
		&j.Status, &j.Attempts, &errMsg, &j.CreatedAt, &j.UpdatedAt,
	); err != nil {
		return nil, err
	}
	if errMsg.Valid {
		j.Error = &errMsg.String
	}
	return &j, nil
}

// UpsertRecognitionJobs batch-inserts pending jobs for the given files in one
// collection, skipping files that already have a job row there (the completed
// ledger). Callers chunk fileIDs (the enqueue scan pages at <=128 files).
// Returns the number of newly inserted jobs.
func (q *Queries) UpsertRecognitionJobs(ctx context.Context, userID uuid.UUID, username string, collectionID uuid.UUID, fileIDs []uuid.UUID) (int, error) {
	if len(fileIDs) == 0 {
		return 0, nil
	}
	ids := make([]string, len(fileIDs))
	for i, id := range fileIDs {
		ids[i] = id.String()
	}
	res, err := q.db.ExecContext(ctx, `
		INSERT INTO recognition_jobs (user_id, username, collection_id, file_id)
		SELECT $1, $2, $3, fid FROM unnest($4::uuid[]) AS fid
		ON CONFLICT (collection_id, file_id) DO NOTHING
	`, userID, username, collectionID, pq.Array(ids))
	if err != nil {
		return 0, fmt.Errorf("UpsertRecognitionJobs: %w", err)
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// ClaimRecognitionJobs atomically claims up to limit pending jobs and marks
// them processing. Claims are interleaved round-robin across users (ROW_NUMBER
// per user_id) so one user's large collection cannot monopolize the queue.
func (q *Queries) ClaimRecognitionJobs(ctx context.Context, limit int) ([]models.RecognitionJob, error) {
	rows, err := q.db.QueryContext(ctx, `
		UPDATE recognition_jobs SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
		WHERE id IN (
			SELECT j.id
			FROM recognition_jobs j
			JOIN (
				SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at, id) AS rn
				FROM recognition_jobs
				WHERE status = 'pending'
			) ranked ON ranked.id = j.id
			ORDER BY ranked.rn, j.id
			LIMIT $1
			FOR UPDATE OF j SKIP LOCKED
		) AND status = 'pending'
		RETURNING `+recognitionJobColumns+`
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("ClaimRecognitionJobs: %w", err)
	}
	defer rows.Close()

	var jobs []models.RecognitionJob
	for rows.Next() {
		j, err := scanRecognitionJob(rows)
		if err != nil {
			return nil, fmt.Errorf("ClaimRecognitionJobs scan: %w", err)
		}
		jobs = append(jobs, *j)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ClaimRecognitionJobs: %w", err)
	}
	return jobs, nil
}

// FinishRecognitionJob sets a claimed job's terminal (or retry) status.
// Passing status "pending" requeues the job for another attempt.
func (q *Queries) FinishRecognitionJob(ctx context.Context, id uuid.UUID, status string, errMsg *string) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE recognition_jobs SET status = $2, error = $3, updated_at = NOW() WHERE id = $1
	`, id, status, errMsg)
	if err != nil {
		return fmt.Errorf("FinishRecognitionJob %s: %w", id, err)
	}
	return nil
}

// ResetStaleRecognitionJobs requeues jobs stuck in processing longer than
// olderThan (worker crash/restart recovery). Returns the number requeued.
func (q *Queries) ResetStaleRecognitionJobs(ctx context.Context, olderThan time.Duration) (int, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE recognition_jobs SET status = 'pending', updated_at = NOW()
		WHERE status = 'processing' AND updated_at < NOW() - $1::interval
	`, fmt.Sprintf("%d seconds", int(olderThan.Seconds())))
	if err != nil {
		return 0, fmt.Errorf("ResetStaleRecognitionJobs: %w", err)
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// CountRecognitionJobsByCollection returns the queue status breakdown for one
// collection (progress counters are always derived, never stored).
func (q *Queries) CountRecognitionJobsByCollection(ctx context.Context, collectionID uuid.UUID) (*RecognitionJobCounts, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT status, COUNT(*) FROM recognition_jobs WHERE collection_id = $1 GROUP BY status
	`, collectionID)
	if err != nil {
		return nil, fmt.Errorf("CountRecognitionJobsByCollection: %w", err)
	}
	defer rows.Close()

	var c RecognitionJobCounts
	for rows.Next() {
		var status string
		var n int
		if err := rows.Scan(&status, &n); err != nil {
			return nil, fmt.Errorf("CountRecognitionJobsByCollection scan: %w", err)
		}
		switch status {
		case models.RecognitionJobPending:
			c.Pending = n
		case models.RecognitionJobProcessing:
			c.Processing = n
		case models.RecognitionJobDone:
			c.Done = n
		case models.RecognitionJobFailed:
			c.Failed = n
		case models.RecognitionJobSkipped:
			c.Skipped = n
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("CountRecognitionJobsByCollection: %w", err)
	}
	return &c, nil
}

// DeletePendingRecognitionJobs removes not-yet-claimed jobs for a collection
// (used when the toggle is turned off). Completed rows are kept as the
// already-indexed ledger.
func (q *Queries) DeletePendingRecognitionJobs(ctx context.Context, collectionID uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		DELETE FROM recognition_jobs WHERE collection_id = $1 AND status = 'pending'
	`, collectionID)
	if err != nil {
		return fmt.Errorf("DeletePendingRecognitionJobs: %w", err)
	}
	return nil
}

func scanRecognitionDetectionRow(rows *sql.Rows) (*models.RecognitionDetection, error) {
	var d models.RecognitionDetection
	var classLabel, thumbKey sql.NullString
	var frameMs sql.NullInt32
	if err := rows.Scan(
		&d.ID, &d.UserID, &d.FileID, &d.Kind, &classLabel, &d.Confidence,
		&d.BBoxX, &d.BBoxY, &d.BBoxW, &d.BBoxH, &frameMs, &d.Embedding,
		&thumbKey, &d.ThumbNonce, &d.ThumbSizeBytes, &d.ModelVersion, &d.CreatedAt,
	); err != nil {
		return nil, err
	}
	if classLabel.Valid {
		d.ClassLabel = &classLabel.String
	}
	if frameMs.Valid {
		v := int(frameMs.Int32)
		d.FrameMs = &v
	}
	if thumbKey.Valid {
		d.ThumbObjectKey = &thumbKey.String
	}
	return &d, nil
}

// InsertRecognitionDetection persists one detection. The caller generates
// d.ID up front (the encrypted crop's object key embeds it, and the crop is
// uploaded before the row is committed). Must run under ForUser (RLS WITH
// CHECK).
func (q *Queries) InsertRecognitionDetection(ctx context.Context, d *models.RecognitionDetection) (*models.RecognitionDetection, error) {
	rows, err := q.db.QueryContext(ctx, `
		INSERT INTO recognition_detections (
			id, user_id, file_id, kind, class_label, confidence,
			bbox_x, bbox_y, bbox_w, bbox_h, frame_ms, embedding,
			thumb_object_key, thumb_nonce, thumb_size_bytes, model_version
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
		RETURNING `+recognitionDetectionColumns+`
	`, d.ID, d.UserID, d.FileID, d.Kind, d.ClassLabel, d.Confidence,
		d.BBoxX, d.BBoxY, d.BBoxW, d.BBoxH, d.FrameMs, d.Embedding,
		d.ThumbObjectKey, d.ThumbNonce, d.ThumbSizeBytes, d.ModelVersion)
	if err != nil {
		return nil, fmt.Errorf("InsertRecognitionDetection: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("InsertRecognitionDetection: %w", err)
		}
		return nil, fmt.Errorf("InsertRecognitionDetection: no row returned")
	}
	out, err := scanRecognitionDetectionRow(rows)
	if err != nil {
		return nil, fmt.Errorf("InsertRecognitionDetection scan: %w", err)
	}
	return out, nil
}

// GetRecognitionDetection returns one detection (thumb crop metadata included).
// Must run under ForUser; returns sql.ErrNoRows when missing or not owned.
func (q *Queries) GetRecognitionDetection(ctx context.Context, id uuid.UUID) (*models.RecognitionDetection, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+recognitionDetectionColumns+` FROM recognition_detections WHERE id = $1
	`, id)
	if err != nil {
		return nil, fmt.Errorf("GetRecognitionDetection: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("GetRecognitionDetection: %w", err)
		}
		return nil, sql.ErrNoRows
	}
	d, err := scanRecognitionDetectionRow(rows)
	if err != nil {
		return nil, fmt.Errorf("GetRecognitionDetection scan: %w", err)
	}
	return d, nil
}

// ListRecognitionDetectionsByFile returns every detection for a file (used to
// re-cluster an already-inferred file into an additional collection).
func (q *Queries) ListRecognitionDetectionsByFile(ctx context.Context, fileID uuid.UUID) ([]models.RecognitionDetection, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+recognitionDetectionColumns+` FROM recognition_detections WHERE file_id = $1 ORDER BY created_at, id
	`, fileID)
	if err != nil {
		return nil, fmt.Errorf("ListRecognitionDetectionsByFile: %w", err)
	}
	defer rows.Close()

	var out []models.RecognitionDetection
	for rows.Next() {
		d, err := scanRecognitionDetectionRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListRecognitionDetectionsByFile scan: %w", err)
		}
		out = append(out, *d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListRecognitionDetectionsByFile: %w", err)
	}
	return out, nil
}

// ListRecognitionCropsByFile returns the crop blobs attached to a file's
// detections so FileService.Delete can remove them from MinIO and refund quota.
func (q *Queries) ListRecognitionCropsByFile(ctx context.Context, fileID uuid.UUID) ([]PurgedRecognitionCrop, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT thumb_object_key, thumb_size_bytes FROM recognition_detections
		WHERE file_id = $1 AND thumb_object_key IS NOT NULL
	`, fileID)
	if err != nil {
		return nil, fmt.Errorf("ListRecognitionCropsByFile: %w", err)
	}
	defer rows.Close()

	var out []PurgedRecognitionCrop
	for rows.Next() {
		var c PurgedRecognitionCrop
		if err := rows.Scan(&c.ObjectKey, &c.SizeBytes); err != nil {
			return nil, fmt.Errorf("ListRecognitionCropsByFile scan: %w", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListRecognitionCropsByFile: %w", err)
	}
	return out, nil
}

func scanRecognitionGroupRow(rows *sql.Rows, withFileCount bool, withCoverFile bool) (*models.RecognitionGroup, error) {
	var g models.RecognitionGroup
	var classLabel, userLabel sql.NullString
	var coverID uuid.NullUUID
	targets := []any{
		&g.ID, &g.UserID, &g.CollectionID, &g.Kind, &classLabel, &g.AutoLabel, &userLabel,
		&g.Centroid, &g.MemberCount, &coverID, &g.CreatedAt, &g.UpdatedAt,
	}
	if withFileCount {
		targets = append(targets, &g.FileCount)
	}
	var coverFileID uuid.NullUUID
	if withCoverFile {
		targets = append(targets, &coverFileID)
	}
	if err := rows.Scan(targets...); err != nil {
		return nil, err
	}
	if classLabel.Valid {
		g.ClassLabel = &classLabel.String
	}
	if userLabel.Valid {
		g.UserLabel = &userLabel.String
	}
	if coverID.Valid {
		g.CoverDetectionID = &coverID.UUID
	}
	if coverFileID.Valid {
		g.CoverFileID = &coverFileID.UUID
	}
	return &g, nil
}

// CreateRecognitionGroup inserts a new group. Must run under ForUser.
func (q *Queries) CreateRecognitionGroup(ctx context.Context, g *models.RecognitionGroup) (*models.RecognitionGroup, error) {
	rows, err := q.db.QueryContext(ctx, `
		INSERT INTO recognition_groups (
			user_id, collection_id, kind, class_label, auto_label, user_label,
			centroid, member_count, cover_detection_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING `+recognitionGroupColumns+`
	`, g.UserID, g.CollectionID, g.Kind, g.ClassLabel, g.AutoLabel, g.UserLabel,
		g.Centroid, g.MemberCount, g.CoverDetectionID)
	if err != nil {
		return nil, fmt.Errorf("CreateRecognitionGroup: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("CreateRecognitionGroup: %w", err)
		}
		return nil, fmt.Errorf("CreateRecognitionGroup: no row returned")
	}
	out, err := scanRecognitionGroupRow(rows, false, false)
	if err != nil {
		return nil, fmt.Errorf("CreateRecognitionGroup scan: %w", err)
	}
	return out, nil
}

// GetRecognitionGroup returns one group without aggregate counts.
func (q *Queries) GetRecognitionGroup(ctx context.Context, id uuid.UUID) (*models.RecognitionGroup, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+recognitionGroupColumns+` FROM recognition_groups WHERE id = $1
	`, id)
	if err != nil {
		return nil, fmt.Errorf("GetRecognitionGroup: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("GetRecognitionGroup: %w", err)
		}
		return nil, sql.ErrNoRows
	}
	g, err := scanRecognitionGroupRow(rows, false, false)
	if err != nil {
		return nil, fmt.Errorf("GetRecognitionGroup scan: %w", err)
	}
	return g, nil
}

// ListRecognitionGroupsByCollection returns a collection's groups with display
// file counts and a fallback cover file id (first member; used by object
// groups whose tiles render a file preview instead of a stored crop).
// kind and labeledOnly are optional filters.
func (q *Queries) ListRecognitionGroupsByCollection(ctx context.Context, collectionID uuid.UUID, kind string, labeledOnly bool) ([]models.RecognitionGroup, error) {
	query := `
		SELECT g.id, g.user_id, g.collection_id, g.kind, g.class_label, g.auto_label, g.user_label,
		       g.centroid, g.member_count, g.cover_detection_id, g.created_at, g.updated_at,
		       COALESCE(m.file_count, 0) AS file_count,
		       cf.file_id AS cover_file_id
		FROM recognition_groups g
		LEFT JOIN LATERAL (
			SELECT COUNT(DISTINCT file_id) AS file_count
			FROM recognition_group_members WHERE group_id = g.id
		) m ON TRUE
		LEFT JOIN LATERAL (
			SELECT file_id FROM recognition_group_members
			WHERE group_id = g.id ORDER BY file_id LIMIT 1
		) cf ON TRUE
		WHERE g.collection_id = $1`
	args := []any{collectionID}
	if kind != "" {
		args = append(args, kind)
		query += fmt.Sprintf(" AND g.kind = $%d", len(args))
	}
	if labeledOnly {
		query += " AND g.user_label IS NOT NULL"
	}
	query += ` ORDER BY file_count DESC, g.created_at, g.id`

	rows, err := q.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("ListRecognitionGroupsByCollection: %w", err)
	}
	defer rows.Close()

	out := []models.RecognitionGroup{}
	for rows.Next() {
		g, err := scanRecognitionGroupRow(rows, true, true)
		if err != nil {
			return nil, fmt.Errorf("ListRecognitionGroupsByCollection scan: %w", err)
		}
		out = append(out, *g)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListRecognitionGroupsByCollection: %w", err)
	}
	return out, nil
}

// UpdateRecognitionGroupLabel sets (or clears, with nil) the user label.
func (q *Queries) UpdateRecognitionGroupLabel(ctx context.Context, id uuid.UUID, label *string) error {
	res, err := q.db.ExecContext(ctx, `
		UPDATE recognition_groups SET user_label = $2, updated_at = NOW() WHERE id = $1
	`, id, label)
	if err != nil {
		return fmt.Errorf("UpdateRecognitionGroupLabel %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// UpdateRecognitionGroupCentroid stores a recomputed centroid and its weight.
func (q *Queries) UpdateRecognitionGroupCentroid(ctx context.Context, id uuid.UUID, centroid []byte, memberCount int) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE recognition_groups SET centroid = $2, member_count = $3, updated_at = NOW() WHERE id = $1
	`, id, centroid, memberCount)
	if err != nil {
		return fmt.Errorf("UpdateRecognitionGroupCentroid %s: %w", id, err)
	}
	return nil
}

// SetRecognitionGroupCover points the group tile at a detection's crop.
func (q *Queries) SetRecognitionGroupCover(ctx context.Context, id, detectionID uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE recognition_groups SET cover_detection_id = $2, updated_at = NOW() WHERE id = $1
	`, id, detectionID)
	if err != nil {
		return fmt.Errorf("SetRecognitionGroupCover %s: %w", id, err)
	}
	return nil
}

// DeleteRecognitionGroup removes a group and (via cascade) its memberships.
// Detections are kept and become unassigned.
func (q *Queries) DeleteRecognitionGroup(ctx context.Context, id uuid.UUID) error {
	res, err := q.db.ExecContext(ctx, `DELETE FROM recognition_groups WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("DeleteRecognitionGroup %s: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// MergeRecognitionGroups repoints the source groups' members at the target
// (dropping duplicates) and deletes the sources. Centroid/label reconciliation
// is done by the caller in the same ForUser transaction.
func (q *Queries) MergeRecognitionGroups(ctx context.Context, targetID uuid.UUID, sourceIDs []uuid.UUID) error {
	ids := make([]string, len(sourceIDs))
	for i, id := range sourceIDs {
		ids[i] = id.String()
	}
	if _, err := q.db.ExecContext(ctx, `
		UPDATE recognition_group_members m SET group_id = $1
		WHERE m.group_id = ANY($2::uuid[])
		  AND NOT EXISTS (
			SELECT 1 FROM recognition_group_members t
			WHERE t.group_id = $1 AND t.detection_id = m.detection_id
		  )
	`, targetID, pq.Array(ids)); err != nil {
		return fmt.Errorf("MergeRecognitionGroups repoint: %w", err)
	}
	if _, err := q.db.ExecContext(ctx, `
		DELETE FROM recognition_groups WHERE id = ANY($1::uuid[])
	`, pq.Array(ids)); err != nil {
		return fmt.Errorf("MergeRecognitionGroups delete: %w", err)
	}
	return nil
}

// AddRecognitionGroupMember attaches a detection to a group (idempotent).
func (q *Queries) AddRecognitionGroupMember(ctx context.Context, groupID, detectionID, fileID, userID uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO recognition_group_members (group_id, detection_id, file_id, user_id)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (group_id, detection_id) DO NOTHING
	`, groupID, detectionID, fileID, userID)
	if err != nil {
		return fmt.Errorf("AddRecognitionGroupMember: %w", err)
	}
	return nil
}

// ListRecognitionGroupFiles pages through the distinct files whose detections
// belong to a group, newest-capture first (same shape the media grid renders).
func (q *Queries) ListRecognitionGroupFiles(ctx context.Context, groupID uuid.UUID, in PageInput) (*PageResult[models.File], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListRecognitionGroupFiles: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, `
		SELECT`+fileColumns+`
		FROM files WHERE id IN (
			SELECT DISTINCT file_id FROM recognition_group_members WHERE group_id = $1
		)
		ORDER BY COALESCE(taken_at, created_at) DESC, id
		LIMIT $2 OFFSET $3
	`, groupID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("ListRecognitionGroupFiles: %w", err)
	}
	defer rows.Close()

	files := []models.File{}
	for rows.Next() {
		f, err := scanFileRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListRecognitionGroupFiles scan: %w", err)
		}
		files = append(files, *f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListRecognitionGroupFiles: %w", err)
	}
	return &PageResult[models.File]{
		Items:     files,
		NextToken: offsetNextToken(len(files), limit, offset),
	}, nil
}

// CountRecognitionGroupsByCollection tallies a collection's groups per kind.
func (q *Queries) CountRecognitionGroupsByCollection(ctx context.Context, collectionID uuid.UUID) (*RecognitionGroupCounts, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT kind, COUNT(*) FROM recognition_groups WHERE collection_id = $1 GROUP BY kind
	`, collectionID)
	if err != nil {
		return nil, fmt.Errorf("CountRecognitionGroupsByCollection: %w", err)
	}
	defer rows.Close()

	var c RecognitionGroupCounts
	for rows.Next() {
		var kind string
		var n int
		if err := rows.Scan(&kind, &n); err != nil {
			return nil, fmt.Errorf("CountRecognitionGroupsByCollection scan: %w", err)
		}
		switch kind {
		case models.RecognitionKindFace:
			c.Face = n
		case models.RecognitionKindPet:
			c.Pet = n
		case models.RecognitionKindObject:
			c.Object = n
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("CountRecognitionGroupsByCollection: %w", err)
	}
	return &c, nil
}

// ListEnabledRecognitionCollectionsForFile returns recognition-enabled media
// collections that reference the file through collection_items pointers.
// Must run under ForUser (folders RLS).
func (q *Queries) ListEnabledRecognitionCollectionsForFile(ctx context.Context, fileID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT f.id FROM folders f
		WHERE f.ai_recognition_enabled AND f.kind = 'media'
		  AND f.id IN (SELECT collection_id FROM collection_items WHERE file_id = $1)
	`, fileID)
	if err != nil {
		return nil, fmt.Errorf("ListEnabledRecognitionCollectionsForFile: %w", err)
	}
	defer rows.Close()

	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("ListEnabledRecognitionCollectionsForFile scan: %w", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListEnabledRecognitionCollectionsForFile: %w", err)
	}
	return out, nil
}

// NextRecognitionAutoLabelSeq returns the next auto-label ordinal for a
// (collection, kind), surviving deletions by scanning existing numeric
// suffixes rather than counting rows.
func (q *Queries) NextRecognitionAutoLabelSeq(ctx context.Context, collectionID uuid.UUID, kind string) (int, error) {
	var next int
	err := q.db.QueryRowContext(ctx, `
		SELECT COALESCE(MAX((regexp_match(auto_label, '(\d+)'))[1]::int), 0) + 1
		FROM recognition_groups WHERE collection_id = $1 AND kind = $2
	`, collectionID, kind).Scan(&next)
	if err != nil {
		return 0, fmt.Errorf("NextRecognitionAutoLabelSeq: %w", err)
	}
	return next, nil
}

// SumRecognitionStorageForCollection totals the encrypted crop bytes
// attributable to one collection (detections of files indexed there).
func (q *Queries) SumRecognitionStorageForCollection(ctx context.Context, collectionID uuid.UUID) (int64, error) {
	var total int64
	err := q.db.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(thumb_size_bytes), 0) FROM recognition_detections
		WHERE file_id IN (SELECT file_id FROM recognition_jobs WHERE collection_id = $1)
	`, collectionID).Scan(&total)
	if err != nil {
		return 0, fmt.Errorf("SumRecognitionStorageForCollection: %w", err)
	}
	return total, nil
}

// SearchRecognitionGroupsByUser matches the user's labeled groups by name for
// the search bar. Only user-labeled groups are searchable.
func (q *Queries) SearchRecognitionGroupsByUser(ctx context.Context, userID uuid.UUID, term string, in PageInput) (*PageResult[RecognitionGroupSearchHit], error) {
	if in.Skip {
		return &PageResult[RecognitionGroupSearchHit]{Items: []RecognitionGroupSearchHit{}}, nil
	}
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("SearchRecognitionGroupsByUser: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, `
		SELECT g.id, g.collection_id, f.name, g.kind, g.class_label, g.user_label,
		       COALESCE(m.file_count, 0) AS file_count,
		       g.cover_detection_id, cf.file_id AS cover_file_id
		FROM recognition_groups g
		JOIN folders f ON f.id = g.collection_id
		LEFT JOIN LATERAL (
			SELECT COUNT(DISTINCT file_id) AS file_count
			FROM recognition_group_members WHERE group_id = g.id
		) m ON TRUE
		LEFT JOIN LATERAL (
			SELECT file_id FROM recognition_group_members
			WHERE group_id = g.id ORDER BY file_id LIMIT 1
		) cf ON TRUE
		WHERE g.user_id = $1 AND g.user_label ILIKE '%' || $2 || '%'
		ORDER BY g.user_label, g.id
		LIMIT $3 OFFSET $4
	`, userID, strings.TrimSpace(term), limit, offset)
	if err != nil {
		return nil, fmt.Errorf("SearchRecognitionGroupsByUser: %w", err)
	}
	defer rows.Close()

	hits := []RecognitionGroupSearchHit{}
	for rows.Next() {
		var h RecognitionGroupSearchHit
		var classLabel sql.NullString
		var coverID, coverFileID uuid.NullUUID
		if err := rows.Scan(
			&h.ID, &h.CollectionID, &h.CollectionName, &h.Kind, &classLabel, &h.Label,
			&h.FileCount, &coverID, &coverFileID,
		); err != nil {
			return nil, fmt.Errorf("SearchRecognitionGroupsByUser scan: %w", err)
		}
		if classLabel.Valid {
			h.ClassLabel = &classLabel.String
		}
		if coverID.Valid {
			h.CoverDetectionID = &coverID.UUID
		}
		if coverFileID.Valid {
			h.CoverFileID = &coverFileID.UUID
		}
		hits = append(hits, h)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("SearchRecognitionGroupsByUser: %w", err)
	}
	return &PageResult[RecognitionGroupSearchHit]{
		Items:     hits,
		NextToken: offsetNextToken(len(hits), limit, offset),
	}, nil
}

// PurgeRecognitionData deletes a collection's groups, its now-orphaned
// detections (those indexed for this collection and referenced by no other
// collection's groups), and its job ledger, returning the freed crop blobs so
// the caller can delete them from MinIO and refund quota. Must run under
// ForUser in a transaction.
func (q *Queries) PurgeRecognitionData(ctx context.Context, collectionID uuid.UUID) ([]PurgedRecognitionCrop, error) {
	if _, err := q.db.ExecContext(ctx, `
		DELETE FROM recognition_groups WHERE collection_id = $1
	`, collectionID); err != nil {
		return nil, fmt.Errorf("PurgeRecognitionData groups: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, `
		DELETE FROM recognition_detections d
		WHERE d.file_id IN (SELECT file_id FROM recognition_jobs WHERE collection_id = $1)
		  AND NOT EXISTS (SELECT 1 FROM recognition_group_members m WHERE m.detection_id = d.id)
		RETURNING d.thumb_object_key, d.thumb_size_bytes,
		          (SELECT f.drive_id FROM files f WHERE f.id = d.file_id)
	`, collectionID)
	if err != nil {
		return nil, fmt.Errorf("PurgeRecognitionData detections: %w", err)
	}
	defer rows.Close()

	var crops []PurgedRecognitionCrop
	for rows.Next() {
		var key sql.NullString
		var size int64
		var driveID uuid.NullUUID
		if err := rows.Scan(&key, &size, &driveID); err != nil {
			return nil, fmt.Errorf("PurgeRecognitionData scan: %w", err)
		}
		if key.Valid {
			crop := PurgedRecognitionCrop{ObjectKey: key.String, SizeBytes: size}
			if driveID.Valid {
				crop.DriveID = &driveID.UUID
			}
			crops = append(crops, crop)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("PurgeRecognitionData: %w", err)
	}

	if _, err := q.db.ExecContext(ctx, `
		DELETE FROM recognition_jobs WHERE collection_id = $1
	`, collectionID); err != nil {
		return nil, fmt.Errorf("PurgeRecognitionData jobs: %w", err)
	}
	return crops, nil
}
