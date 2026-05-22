package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// DeltaSyncFiles returns all files owned by userID that were created after since.
// The caller is expected to pass the server_time from the previous delta response
// as since to avoid clock-skew issues.
func (q *Queries) DeltaSyncFiles(ctx context.Context, userID uuid.UUID, since time.Time) ([]models.File, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT`+fileColumns+`
		FROM files
		WHERE user_id = $1 AND created_at > $2
		ORDER BY created_at ASC
	`, userID, since)
	if err != nil {
		return nil, fmt.Errorf("DeltaSyncFiles: %w", err)
	}
	defer rows.Close()

	var files []models.File
	for rows.Next() {
		f, err := scanFileRow(rows)
		if err != nil {
			return nil, fmt.Errorf("DeltaSyncFiles scan: %w", err)
		}
		files = append(files, *f)
	}
	return files, rows.Err()
}

// DeltaSyncDeleted returns file IDs that were deleted after since for the given user.
func (q *Queries) DeltaSyncDeleted(ctx context.Context, userID uuid.UUID, since time.Time) ([]uuid.UUID, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT id FROM deleted_file_log
		WHERE user_id = $1 AND deleted_at > $2
		ORDER BY deleted_at ASC
	`, userID, since)
	if err != nil {
		return nil, fmt.Errorf("DeltaSyncDeleted: %w", err)
	}
	defer rows.Close()

	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("DeltaSyncDeleted scan: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// FindFileByHash looks up a file owned by userID whose sha256_hash matches hash.
// Returns sql.ErrNoRows when no match is found.
func (q *Queries) FindFileByHash(ctx context.Context, userID uuid.UUID, hash string) (*models.File, error) {
	row := q.db.QueryRowContext(ctx,
		`SELECT`+fileColumns+`FROM files WHERE user_id = $1 AND sha256_hash = $2 LIMIT 1`,
		userID, hash,
	)
	f, err := scanFile(row)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, sql.ErrNoRows
		}
		return nil, fmt.Errorf("FindFileByHash: %w", err)
	}
	return f, nil
}
