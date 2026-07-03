package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

const folderDriveMigrationColumns = `
	id, folder_id, user_id, from_drive_id, to_drive_id, status,
	total_files, files_moved, total_bytes, bytes_moved, error_message,
	created_at, completed_at`

func scanFolderDriveMigration(row interface {
	Scan(...any) error
}) (*models.FolderDriveMigration, error) {
	var m models.FolderDriveMigration
	var fromDriveID uuid.NullUUID
	var errorMessage sql.NullString
	var completedAt sql.NullTime
	err := row.Scan(
		&m.ID, &m.FolderID, &m.UserID, &fromDriveID, &m.ToDriveID, &m.Status,
		&m.TotalFiles, &m.FilesMoved, &m.TotalBytes, &m.BytesMoved, &errorMessage,
		&m.CreatedAt, &completedAt,
	)
	if err != nil {
		return nil, err
	}
	if fromDriveID.Valid {
		m.FromDriveID = &fromDriveID.UUID
	}
	if errorMessage.Valid {
		m.ErrorMessage = &errorMessage.String
	}
	if completedAt.Valid {
		m.CompletedAt = &completedAt.Time
	}
	return &m, nil
}

// CreateFolderDriveMigration inserts a new pending migration row and returns it.
// fromDriveID may be nil when the folder previously had no pinned drive.
func (q *Queries) CreateFolderDriveMigration(ctx context.Context, folderID, userID uuid.UUID, fromDriveID *uuid.UUID, toDriveID uuid.UUID) (*models.FolderDriveMigration, error) {
	var from uuid.NullUUID
	if fromDriveID != nil {
		from = uuid.NullUUID{UUID: *fromDriveID, Valid: true}
	}
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO folder_drive_migrations (id, folder_id, user_id, from_drive_id, to_drive_id, status)
		VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
		RETURNING `+folderDriveMigrationColumns+`
	`, folderID, userID, from, toDriveID, models.FolderDriveMigrationStatusPending)
	m, err := scanFolderDriveMigration(row)
	if err != nil {
		return nil, fmt.Errorf("CreateFolderDriveMigration: %w", err)
	}
	return m, nil
}

// GetLatestFolderDriveMigration returns the most recently created migration row
// for folderID, regardless of status. Returns sql.ErrNoRows if none exist.
func (q *Queries) GetLatestFolderDriveMigration(ctx context.Context, folderID uuid.UUID) (*models.FolderDriveMigration, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT `+folderDriveMigrationColumns+`
		FROM folder_drive_migrations
		WHERE folder_id = $1
		ORDER BY created_at DESC
		LIMIT 1
	`, folderID)
	m, err := scanFolderDriveMigration(row)
	if err != nil {
		return nil, fmt.Errorf("GetLatestFolderDriveMigration: %w", err)
	}
	return m, nil
}

// GetFolderDriveMigrationByID returns a single migration row by id.
// Returns sql.ErrNoRows if not found.
func (q *Queries) GetFolderDriveMigrationByID(ctx context.Context, id uuid.UUID) (*models.FolderDriveMigration, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT `+folderDriveMigrationColumns+`
		FROM folder_drive_migrations
		WHERE id = $1
	`, id)
	m, err := scanFolderDriveMigration(row)
	if err != nil {
		return nil, fmt.Errorf("GetFolderDriveMigrationByID %s: %w", id, err)
	}
	return m, nil
}

// CountRecentFolderDriveMigrations counts migration rows for folderID created
// within the trailing 30 days. This IS the rate-limit check — no separate
// counter table is maintained.
func (q *Queries) CountRecentFolderDriveMigrations(ctx context.Context, folderID uuid.UUID) (int, error) {
	var count int
	err := q.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM folder_drive_migrations
		WHERE folder_id = $1 AND created_at > NOW() - INTERVAL '30 days'
	`, folderID).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("CountRecentFolderDriveMigrations %s: %w", folderID, err)
	}
	return count, nil
}

// OldestRecentFolderDriveMigrationCreatedAt returns the created_at of the
// oldest migration row counted by CountRecentFolderDriveMigrations (i.e. the
// oldest row within the trailing 30-day window). Used to compute when the next
// rate-limit slot opens (created_at + 30 days). Returns sql.ErrNoRows if there
// are no rows in the window.
func (q *Queries) OldestRecentFolderDriveMigrationCreatedAt(ctx context.Context, folderID uuid.UUID) (time.Time, error) {
	var createdAt time.Time
	err := q.db.QueryRowContext(ctx, `
		SELECT created_at FROM folder_drive_migrations
		WHERE folder_id = $1 AND created_at > NOW() - INTERVAL '30 days'
		ORDER BY created_at ASC
		LIMIT 1
	`, folderID).Scan(&createdAt)
	if err != nil {
		return time.Time{}, fmt.Errorf("OldestRecentFolderDriveMigrationCreatedAt %s: %w", folderID, err)
	}
	return createdAt, nil
}

// GetPendingOrInProgressFolderDriveMigration returns the folder's active
// migration row (status pending or in_progress), if any. Returns sql.ErrNoRows
// if none is active.
func (q *Queries) GetPendingOrInProgressFolderDriveMigration(ctx context.Context, folderID uuid.UUID) (*models.FolderDriveMigration, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT `+folderDriveMigrationColumns+`
		FROM folder_drive_migrations
		WHERE folder_id = $1 AND status IN ($2, $3)
		ORDER BY created_at DESC
		LIMIT 1
	`, folderID, models.FolderDriveMigrationStatusPending, models.FolderDriveMigrationStatusInProgress)
	m, err := scanFolderDriveMigration(row)
	if err != nil {
		return nil, fmt.Errorf("GetPendingOrInProgressFolderDriveMigration %s: %w", folderID, err)
	}
	return m, nil
}

// MarkFolderDriveMigrationInProgress transitions a migration to in_progress and
// records the total file count/bytes to move.
func (q *Queries) MarkFolderDriveMigrationInProgress(ctx context.Context, id uuid.UUID, totalFiles int, totalBytes int64) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE folder_drive_migrations
		SET status = $2, total_files = $3, total_bytes = $4
		WHERE id = $1
	`, id, models.FolderDriveMigrationStatusInProgress, totalFiles, totalBytes)
	if err != nil {
		return fmt.Errorf("MarkFolderDriveMigrationInProgress %s: %w", id, err)
	}
	return nil
}

// UpdateFolderDriveMigrationProgress persists coarse per-file progress after a
// single file finishes moving.
func (q *Queries) UpdateFolderDriveMigrationProgress(ctx context.Context, id uuid.UUID, filesMoved int, bytesMoved int64) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE folder_drive_migrations
		SET files_moved = $2, bytes_moved = $3
		WHERE id = $1
	`, id, filesMoved, bytesMoved)
	if err != nil {
		return fmt.Errorf("UpdateFolderDriveMigrationProgress %s: %w", id, err)
	}
	return nil
}

// MarkFolderDriveMigrationCompleted transitions a migration to completed and
// stamps completed_at.
func (q *Queries) MarkFolderDriveMigrationCompleted(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE folder_drive_migrations
		SET status = $2, completed_at = NOW()
		WHERE id = $1
	`, id, models.FolderDriveMigrationStatusCompleted)
	if err != nil {
		return fmt.Errorf("MarkFolderDriveMigrationCompleted %s: %w", id, err)
	}
	return nil
}

// MarkFolderDriveMigrationFailed transitions a migration to failed, records
// errMsg, and stamps completed_at. Already-moved files are left moved — no
// automatic rollback is attempted.
func (q *Queries) MarkFolderDriveMigrationFailed(ctx context.Context, id uuid.UUID, errMsg string) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE folder_drive_migrations
		SET status = $2, error_message = $3, completed_at = NOW()
		WHERE id = $1
	`, id, models.FolderDriveMigrationStatusFailed, errMsg)
	if err != nil {
		return fmt.Errorf("MarkFolderDriveMigrationFailed %s: %w", id, err)
	}
	return nil
}
