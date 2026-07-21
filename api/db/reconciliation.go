package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// ── Run + finding ledger ──────────────────────────────────────────────────────

// CreateReconciliationRun inserts a new run row (started_at = now) and returns it.
func (q *Queries) CreateReconciliationRun(ctx context.Context) (*models.ReconciliationRun, error) {
	var r models.ReconciliationRun
	err := q.db.QueryRowContext(ctx, `
		INSERT INTO reconciliation_runs DEFAULT VALUES
		RETURNING id, started_at, finished_at, drives_scanned, objects_scanned, rows_scanned,
			orphans_found, orphans_deleted, ghosts_found, ghosts_deleted, abandoned_uploads_aborted, error
	`).Scan(&r.ID, &r.StartedAt, &r.FinishedAt, &r.DrivesScanned, &r.ObjectsScanned, &r.RowsScanned,
		&r.OrphansFound, &r.OrphansDeleted, &r.GhostsFound, &r.GhostsDeleted, &r.AbandonedUploadsAborted, &r.Error)
	if err != nil {
		return nil, fmt.Errorf("CreateReconciliationRun: %w", err)
	}
	return &r, nil
}

// FinishReconciliationRun records the final counts (and optional error) for a run.
func (q *Queries) FinishReconciliationRun(ctx context.Context, r *models.ReconciliationRun) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE reconciliation_runs SET
			finished_at = NOW(),
			drives_scanned = $2, objects_scanned = $3, rows_scanned = $4,
			orphans_found = $5, orphans_deleted = $6,
			ghosts_found = $7, ghosts_deleted = $8,
			abandoned_uploads_aborted = $9, error = $10
		WHERE id = $1
	`, r.ID, r.DrivesScanned, r.ObjectsScanned, r.RowsScanned,
		r.OrphansFound, r.OrphansDeleted, r.GhostsFound, r.GhostsDeleted,
		r.AbandonedUploadsAborted, r.Error)
	if err != nil {
		return fmt.Errorf("FinishReconciliationRun: %w", err)
	}
	return nil
}

// GetLatestReconciliationRun returns the most recently started run, or nil if none exist.
func (q *Queries) GetLatestReconciliationRun(ctx context.Context) (*models.ReconciliationRun, error) {
	var r models.ReconciliationRun
	err := q.db.QueryRowContext(ctx, `
		SELECT id, started_at, finished_at, drives_scanned, objects_scanned, rows_scanned,
			orphans_found, orphans_deleted, ghosts_found, ghosts_deleted, abandoned_uploads_aborted, error
		FROM reconciliation_runs ORDER BY started_at DESC LIMIT 1
	`).Scan(&r.ID, &r.StartedAt, &r.FinishedAt, &r.DrivesScanned, &r.ObjectsScanned, &r.RowsScanned,
		&r.OrphansFound, &r.OrphansDeleted, &r.GhostsFound, &r.GhostsDeleted, &r.AbandonedUploadsAborted, &r.Error)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetLatestReconciliationRun: %w", err)
	}
	return &r, nil
}

// InsertReconciliationFinding records one piece of drift. runID is nil for
// findings logged outside of a scheduled scan (e.g. a failed drive-migration
// cleanup) — they still surface in the admin ledger via ListReconciliationFindings.
func (q *Queries) InsertReconciliationFinding(ctx context.Context, f *models.ReconciliationFinding) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO reconciliation_findings
			(run_id, kind, drive_id, bucket, object_key, user_id, file_id, detail, action, error)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	`, f.RunID, f.Kind, f.DriveID, f.Bucket, f.ObjectKey, f.UserID, f.FileID, f.Detail, f.Action, f.Error)
	if err != nil {
		return fmt.Errorf("InsertReconciliationFinding: %w", err)
	}
	return nil
}

// ListReconciliationFindings returns the most recent findings for a run
// (runID != nil), or the most recent findings overall (runID == nil) — the
// latter surfaces inline findings (e.g. drive-migration cleanup failures)
// logged between scheduled scans.
func (q *Queries) ListReconciliationFindings(ctx context.Context, runID *uuid.UUID, limit int) ([]models.ReconciliationFinding, error) {
	limit = clampLimit(limit)
	var rows *sql.Rows
	var err error
	if runID != nil {
		rows, err = q.db.QueryContext(ctx, `
			SELECT id, run_id, kind, drive_id, bucket, object_key, user_id, file_id, detail, action, error, created_at
			FROM reconciliation_findings WHERE run_id = $1 ORDER BY created_at DESC LIMIT $2
		`, *runID, limit)
	} else {
		rows, err = q.db.QueryContext(ctx, `
			SELECT id, run_id, kind, drive_id, bucket, object_key, user_id, file_id, detail, action, error, created_at
			FROM reconciliation_findings ORDER BY created_at DESC LIMIT $1
		`, limit)
	}
	if err != nil {
		return nil, fmt.Errorf("ListReconciliationFindings: %w", err)
	}
	defer rows.Close()

	var out []models.ReconciliationFinding
	for rows.Next() {
		var f models.ReconciliationFinding
		var bucket, objectKey, detail sql.NullString
		if err := rows.Scan(&f.ID, &f.RunID, &f.Kind, &f.DriveID, &bucket, &objectKey,
			&f.UserID, &f.FileID, &detail, &f.Action, &f.Error, &f.CreatedAt); err != nil {
			return nil, fmt.Errorf("ListReconciliationFindings scan: %w", err)
		}
		f.Bucket = bucket.String
		f.ObjectKey = objectKey.String
		f.Detail = detail.String
		out = append(out, f)
	}
	return out, rows.Err()
}

// ── Per-drive scan sources ────────────────────────────────────────────────────

// ListActiveDrivesWithServer returns every active drive together with its
// server (and node-endpoint-override flag), for the reconciliation scanner to
// resolve a MinIO client + bucket per drive.
func (q *Queries) ListActiveDrivesWithServer(ctx context.Context) ([]models.UserDriveAllocation, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT
			d.id, d.server_id, d.node_id, d.label, d.capacity_bytes, d.minio_bucket, d.drive_type, d.is_active, d.created_at,
			s.id, s.name, s.state, s.minio_endpoint, s.minio_use_ssl,
			s.minio_access_key_enc, s.minio_access_key_nonce,
			s.minio_secret_key_enc, s.minio_secret_key_nonce,
			s.is_active, s.created_at,
			(n.minio_endpoint IS NOT NULL AND n.minio_endpoint <> '') AS node_has_minio
		FROM drives d
		JOIN servers s ON s.id = d.server_id
		LEFT JOIN nodes n ON n.id = d.node_id
		WHERE d.is_active = true AND s.is_active = true
		ORDER BY d.created_at ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("ListActiveDrivesWithServer: %w", err)
	}
	defer rows.Close()

	var out []models.UserDriveAllocation
	for rows.Next() {
		var a models.UserDriveAllocation
		if err := rows.Scan(
			&a.Drive.ID, &a.Drive.ServerID, &a.Drive.NodeID, &a.Drive.Label, &a.Drive.CapacityBytes,
			&a.Drive.MinioBucket, &a.Drive.DriveType, &a.Drive.IsActive, &a.Drive.CreatedAt,
			&a.Server.ID, &a.Server.Name, &a.Server.State, &a.Server.MinioEndpoint, &a.Server.MinioUseSSL,
			&a.Server.MinioAccessKeyEnc, &a.Server.MinioAccessKeyNonce,
			&a.Server.MinioSecretKeyEnc, &a.Server.MinioSecretKeyNonce,
			&a.Server.IsActive, &a.Server.CreatedAt,
			&a.NodeHasMinIO,
		); err != nil {
			return nil, fmt.Errorf("ListActiveDrivesWithServer scan: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ReconcileFileKey is one files row's identity for the reconciliation diff.
type ReconcileFileKey struct {
	ID        uuid.UUID
	UserID    uuid.UUID
	ObjectKey string
	SizeBytes int64
	CreatedAt time.Time
}

// ListFileKeysByDrive returns every files row currently assigned to driveID.
func (q *Queries) ListFileKeysByDrive(ctx context.Context, driveID uuid.UUID) ([]ReconcileFileKey, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT id, user_id, minio_object_key, size_bytes, created_at
		FROM files WHERE drive_id = $1
	`, driveID)
	if err != nil {
		return nil, fmt.Errorf("ListFileKeysByDrive: %w", err)
	}
	defer rows.Close()

	var out []ReconcileFileKey
	for rows.Next() {
		var k ReconcileFileKey
		if err := rows.Scan(&k.ID, &k.UserID, &k.ObjectKey, &k.SizeBytes, &k.CreatedAt); err != nil {
			return nil, fmt.Errorf("ListFileKeysByDrive scan: %w", err)
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// ReconcileVariantKey is one video_variants row's identity for the
// reconciliation diff. DriveID reflects the parent file's *current* drive_id
// for informational purposes only — it is not used to scope presence checks,
// because drive-tier migrations do not move variant blobs (a documented V1
// limitation of folder_drive_migration.go), so a variant can legitimately live
// in a different bucket than its parent file's current drive.
type ReconcileVariantKey struct {
	ID        uuid.UUID
	FileID    uuid.UUID
	UserID    uuid.UUID
	DriveID   *uuid.UUID
	ObjectKey string
	CreatedAt time.Time
}

// ListAllVideoVariantKeys returns every video_variants row, system-wide (not
// scoped to a drive — see ReconcileVariantKey).
func (q *Queries) ListAllVideoVariantKeys(ctx context.Context) ([]ReconcileVariantKey, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT vv.id, vv.file_id, f.user_id, f.drive_id, vv.minio_object_key, vv.created_at
		FROM video_variants vv
		JOIN files f ON f.id = vv.file_id
	`)
	if err != nil {
		return nil, fmt.Errorf("ListAllVideoVariantKeys: %w", err)
	}
	defer rows.Close()

	var out []ReconcileVariantKey
	for rows.Next() {
		var k ReconcileVariantKey
		if err := rows.Scan(&k.ID, &k.FileID, &k.UserID, &k.DriveID, &k.ObjectKey, &k.CreatedAt); err != nil {
			return nil, fmt.Errorf("ListAllVideoVariantKeys scan: %w", err)
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// ReconcileCropKey is one recognition_detections row's crop identity for the
// reconciliation diff (only rows with a non-null thumb_object_key). DriveID is
// informational only — see ReconcileVariantKey.
type ReconcileCropKey struct {
	ID        uuid.UUID
	FileID    uuid.UUID
	UserID    uuid.UUID
	DriveID   *uuid.UUID
	ObjectKey string
	SizeBytes int64
	CreatedAt time.Time
}

// ListAllRecognitionCropKeys returns every recognition_detections row with a
// crop blob, system-wide (not scoped to a drive — see ReconcileCropKey).
func (q *Queries) ListAllRecognitionCropKeys(ctx context.Context) ([]ReconcileCropKey, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT rd.id, rd.file_id, rd.user_id, f.drive_id, rd.thumb_object_key, rd.thumb_size_bytes, rd.created_at
		FROM recognition_detections rd
		JOIN files f ON f.id = rd.file_id
		WHERE rd.thumb_object_key IS NOT NULL
	`)
	if err != nil {
		return nil, fmt.Errorf("ListAllRecognitionCropKeys: %w", err)
	}
	defer rows.Close()

	var out []ReconcileCropKey
	for rows.Next() {
		var k ReconcileCropKey
		if err := rows.Scan(&k.ID, &k.FileID, &k.UserID, &k.DriveID, &k.ObjectKey, &k.SizeBytes, &k.CreatedAt); err != nil {
			return nil, fmt.Errorf("ListAllRecognitionCropKeys scan: %w", err)
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// DeleteVideoVariantRow removes a single video_variants row (repair for a
// ghost row whose blob is confirmed missing from MinIO). Video variants are
// derived transcodes and are not counted against user storage quota, so no
// quota refund is needed.
func (q *Queries) DeleteVideoVariantRow(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `DELETE FROM video_variants WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("DeleteVideoVariantRow: %w", err)
	}
	return nil
}

// ClearRecognitionCrop nulls out a recognition_detections row's crop fields
// (repair for a ghost crop whose blob is confirmed missing from MinIO). The
// detection row itself (embedding, cluster membership) is preserved — only the
// thumbnail image is gone.
func (q *Queries) ClearRecognitionCrop(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE recognition_detections
		SET thumb_object_key = NULL, thumb_nonce = NULL, thumb_size_bytes = 0
		WHERE id = $1
	`, id)
	if err != nil {
		return fmt.Errorf("ClearRecognitionCrop: %w", err)
	}
	return nil
}
