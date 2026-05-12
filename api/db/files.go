package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

const fileColumns = `
	id, user_id, folder_id, drive_id, name, mime_type,
	size_bytes, minio_object_key, nonce, created_at, updated_at`

func scanFile(row *sql.Row) (*models.File, error) {
	var f models.File
	var folderID uuid.NullUUID
	var driveID uuid.NullUUID
	err := row.Scan(
		&f.ID, &f.UserID, &folderID, &driveID, &f.Name, &f.MimeType,
		&f.SizeBytes, &f.MinIOObjectKey, &f.Nonce, &f.CreatedAt, &f.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if folderID.Valid {
		f.FolderID = &folderID.UUID
	}
	if driveID.Valid {
		f.DriveID = &driveID.UUID
	}
	return &f, nil
}

func scanFileRow(rows *sql.Rows) (*models.File, error) {
	var f models.File
	var folderID uuid.NullUUID
	var driveID uuid.NullUUID
	err := rows.Scan(
		&f.ID, &f.UserID, &folderID, &driveID, &f.Name, &f.MimeType,
		&f.SizeBytes, &f.MinIOObjectKey, &f.Nonce, &f.CreatedAt, &f.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if folderID.Valid {
		f.FolderID = &folderID.UUID
	}
	if driveID.Valid {
		f.DriveID = &driveID.UUID
	}
	return &f, nil
}

// CreateFile inserts a new file metadata row and returns it with the
// server-generated id and timestamps. The encrypted blob must already be
// written to MinIO before calling this.
func (q *Queries) CreateFile(ctx context.Context, f *models.File) (*models.File, error) {
	var folderID uuid.NullUUID
	if f.FolderID != nil {
		folderID = uuid.NullUUID{UUID: *f.FolderID, Valid: true}
	}
	var driveID uuid.NullUUID
	if f.DriveID != nil {
		driveID = uuid.NullUUID{UUID: *f.DriveID, Valid: true}
	}
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO files (
			id, user_id, folder_id, drive_id, name, mime_type,
			size_bytes, minio_object_key, nonce, created_at, updated_at
		) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
		RETURNING`+fileColumns,
		f.UserID, folderID, driveID, f.Name, f.MimeType,
		f.SizeBytes, f.MinIOObjectKey, f.Nonce,
	)
	out, err := scanFile(row)
	if err != nil {
		return nil, fmt.Errorf("CreateFile: %w", err)
	}
	return out, nil
}

// GetFileByID returns a single file record. Returns sql.ErrNoRows if not found.
func (q *Queries) GetFileByID(ctx context.Context, id uuid.UUID) (*models.File, error) {
	row := q.db.QueryRowContext(ctx,
		`SELECT`+fileColumns+`FROM files WHERE id = $1`, id)
	f, err := scanFile(row)
	if err != nil {
		return nil, fmt.Errorf("GetFileByID %s: %w", id, err)
	}
	return f, nil
}

// ListFilesByFolder returns a page of files in a folder, ordered by name.
func (q *Queries) ListFilesByFolder(ctx context.Context, folderID uuid.UUID, in PageInput) (*PageResult[models.File], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListFilesByFolder: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, `
		SELECT`+fileColumns+`
		FROM files WHERE folder_id = $1
		ORDER BY name ASC
		LIMIT $2 OFFSET $3
	`, folderID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("ListFilesByFolder: %w", err)
	}
	defer rows.Close()

	files := make([]models.File, 0)
	for rows.Next() {
		f, err := scanFileRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListFilesByFolder scan: %w", err)
		}
		files = append(files, *f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListFilesByFolder: %w", err)
	}
	return &PageResult[models.File]{
		Items:     files,
		NextToken: offsetNextToken(len(files), limit, offset),
	}, nil
}

// ListRootFiles returns a page of files owned by userID that have no containing
// folder (folder_id IS NULL), ordered by name.
func (q *Queries) ListRootFiles(ctx context.Context, userID uuid.UUID, in PageInput) (*PageResult[models.File], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListRootFiles: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, `
		SELECT`+fileColumns+`
		FROM files
		WHERE user_id = $1 AND folder_id IS NULL
		ORDER BY name ASC
		LIMIT $2 OFFSET $3
	`, userID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("ListRootFiles: %w", err)
	}
	defer rows.Close()

	files := make([]models.File, 0)
	for rows.Next() {
		f, err := scanFileRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListRootFiles scan: %w", err)
		}
		files = append(files, *f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListRootFiles: %w", err)
	}
	return &PageResult[models.File]{
		Items:     files,
		NextToken: offsetNextToken(len(files), limit, offset),
	}, nil
}

// SearchFilesByUser returns a page of files owned by userID whose name
// contains term (case-insensitive), ordered by name.
func (q *Queries) SearchFilesByUser(ctx context.Context, userID uuid.UUID, term string, in PageInput) (*PageResult[models.File], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("SearchFilesByUser: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, `
		SELECT`+fileColumns+`
		FROM files
		WHERE user_id = $1 AND name ILIKE '%' || $2 || '%'
		ORDER BY name ASC
		LIMIT $3 OFFSET $4
	`, userID, term, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("SearchFilesByUser: %w", err)
	}
	defer rows.Close()

	files := make([]models.File, 0)
	for rows.Next() {
		f, err := scanFileRow(rows)
		if err != nil {
			return nil, fmt.Errorf("SearchFilesByUser scan: %w", err)
		}
		files = append(files, *f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("SearchFilesByUser: %w", err)
	}
	return &PageResult[models.File]{
		Items:     files,
		NextToken: offsetNextToken(len(files), limit, offset),
	}, nil
}

// ListFilesByUser returns a page of all files owned by userID across all folders,
// ordered by name.
func (q *Queries) ListFilesByUser(ctx context.Context, userID uuid.UUID, in PageInput) (*PageResult[models.File], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListFilesByUser: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, `
		SELECT`+fileColumns+`
		FROM files WHERE user_id = $1
		ORDER BY name ASC
		LIMIT $2 OFFSET $3
	`, userID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("ListFilesByUser: %w", err)
	}
	defer rows.Close()

	files := make([]models.File, 0)
	for rows.Next() {
		f, err := scanFileRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListFilesByUser scan: %w", err)
		}
		files = append(files, *f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListFilesByUser: %w", err)
	}
	return &PageResult[models.File]{
		Items:     files,
		NextToken: offsetNextToken(len(files), limit, offset),
	}, nil
}

// UpdateFileName renames a file and bumps updated_at. Returns the updated record.
func (q *Queries) UpdateFileName(ctx context.Context, id uuid.UUID, name string) (*models.File, error) {
	row := q.db.QueryRowContext(ctx, `
		UPDATE files SET name = $2, updated_at = NOW()
		WHERE id = $1
		RETURNING`+fileColumns,
		id, name)
	f, err := scanFile(row)
	if err != nil {
		return nil, fmt.Errorf("UpdateFileName %s: %w", id, err)
	}
	return f, nil
}

// MoveFile updates a file's folder_id. Ownership is enforced at the service
// layer before this is called.
func (q *Queries) MoveFile(ctx context.Context, fileID, newFolderID uuid.UUID) (*models.File, error) {
	row := q.db.QueryRowContext(ctx, `
		UPDATE files SET folder_id = $2, updated_at = NOW()
		WHERE id = $1
		RETURNING`+fileColumns,
		fileID, newFolderID)
	f, err := scanFile(row)
	if err != nil {
		return nil, fmt.Errorf("MoveFile %s: %w", fileID, err)
	}
	return f, nil
}

// DeleteFile removes a file metadata row by id. The caller is responsible for
// deleting the corresponding blob from MinIO before or after calling this.
func (q *Queries) DeleteFile(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `DELETE FROM files WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("DeleteFile %s: %w", id, err)
	}
	return nil
}
