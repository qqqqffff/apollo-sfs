package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

const fileColumns = `
	id, user_id, folder_id, drive_id, name, mime_type,
	size_bytes, minio_object_key, nonce, taken_at, sha256_hash, hidden, created_at, updated_at`

func scanFile(row *sql.Row) (*models.File, error) {
	var f models.File
	var folderID uuid.NullUUID
	var driveID uuid.NullUUID
	var takenAt sql.NullTime
	var sha256Hash sql.NullString
	err := row.Scan(
		&f.ID, &f.UserID, &folderID, &driveID, &f.Name, &f.MimeType,
		&f.SizeBytes, &f.MinIOObjectKey, &f.Nonce, &takenAt, &sha256Hash, &f.Hidden, &f.CreatedAt, &f.UpdatedAt,
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
	if takenAt.Valid {
		f.TakenAt = &takenAt.Time
	}
	if sha256Hash.Valid {
		f.SHA256Hash = &sha256Hash.String
	}
	return &f, nil
}

func scanFileRow(rows *sql.Rows) (*models.File, error) {
	var f models.File
	var folderID uuid.NullUUID
	var driveID uuid.NullUUID
	var takenAt sql.NullTime
	var sha256Hash sql.NullString
	err := rows.Scan(
		&f.ID, &f.UserID, &folderID, &driveID, &f.Name, &f.MimeType,
		&f.SizeBytes, &f.MinIOObjectKey, &f.Nonce, &takenAt, &sha256Hash, &f.Hidden, &f.CreatedAt, &f.UpdatedAt,
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
	if takenAt.Valid {
		f.TakenAt = &takenAt.Time
	}
	if sha256Hash.Valid {
		f.SHA256Hash = &sha256Hash.String
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
	var takenAt sql.NullTime
	if f.TakenAt != nil {
		takenAt = sql.NullTime{Time: *f.TakenAt, Valid: true}
	}
	var sha256Hash sql.NullString
	if f.SHA256Hash != nil {
		sha256Hash = sql.NullString{String: *f.SHA256Hash, Valid: true}
	}
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO files (
			id, user_id, folder_id, drive_id, name, mime_type,
			size_bytes, minio_object_key, nonce, taken_at, sha256_hash, created_at, updated_at
		) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
		RETURNING`+fileColumns,
		f.UserID, folderID, driveID, f.Name, f.MimeType,
		f.SizeBytes, f.MinIOObjectKey, f.Nonce, takenAt, sha256Hash,
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

// DeleteFile removes a file metadata row by id and writes a tombstone to
// deleted_file_log so mobile delta-sync can notify clients of the deletion.
// The caller is responsible for deleting the corresponding MinIO blob.
func (q *Queries) DeleteFile(ctx context.Context, id, userID uuid.UUID) error {
	if _, err := q.db.ExecContext(ctx,
		`INSERT INTO deleted_file_log (id, user_id) VALUES ($1, $2)`, id, userID,
	); err != nil {
		return fmt.Errorf("DeleteFile tombstone %s: %w", id, err)
	}
	if _, err := q.db.ExecContext(ctx, `DELETE FROM files WHERE id = $1`, id); err != nil {
		return fmt.Errorf("DeleteFile %s: %w", id, err)
	}
	return nil
}

// GetAllUserFiles returns all file records owned by username (no pagination).
// Used for bulk deletion during a permanent ban.
func (q *Queries) GetAllUserFiles(ctx context.Context, username string) ([]models.File, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT`+fileColumns+`
		FROM files WHERE user_id = $1::uuid
	`, username)
	if err != nil {
		return nil, fmt.Errorf("GetAllUserFiles: %w", err)
	}
	defer rows.Close()

	files := make([]models.File, 0)
	for rows.Next() {
		f, err := scanFileRow(rows)
		if err != nil {
			return nil, fmt.Errorf("GetAllUserFiles scan: %w", err)
		}
		files = append(files, *f)
	}
	return files, rows.Err()
}

// DeleteAllUserFileRows bulk-deletes every file row for username.
// The caller must delete the MinIO objects first.
func (q *Queries) DeleteAllUserFileRows(ctx context.Context, username string) error {
	_, err := q.db.ExecContext(ctx,
		`DELETE FROM files WHERE user_id = $1::uuid`, username)
	if err != nil {
		return fmt.Errorf("DeleteAllUserFileRows: %w", err)
	}
	return nil
}

// ── Media collection listing ───────────────────────────────────────────────

// MediaSort selects the ordering for a media collection listing.
type MediaSort string

const (
	// MediaSortTakenAt orders by capture date (newest first), falling back to
	// upload date when taken_at is null.
	MediaSortTakenAt MediaSort = "taken_at"
	// MediaSortCreated orders by upload date (newest first).
	MediaSortCreated MediaSort = "created_at"
	// MediaSortName orders alphabetically by name.
	MediaSortName MediaSort = "name"
)

// HiddenFilter controls whether hidden files appear in a media listing.
type HiddenFilter int

const (
	// HiddenExclude omits hidden files (default collection view).
	HiddenExclude HiddenFilter = iota
	// HiddenInclude returns hidden and visible files together ("show hidden").
	HiddenInclude
	// HiddenOnly returns only hidden files (the dedicated hidden view).
	HiddenOnly
)

// orderClause maps a MediaSort to a fixed ORDER BY fragment. The mapping is a
// closed set (never user-interpolated) so this is injection-safe.
func (s MediaSort) orderClause() string {
	switch s {
	case MediaSortCreated:
		return "f.created_at DESC, f.name ASC"
	case MediaSortName:
		return "f.name ASC"
	default: // MediaSortTakenAt
		return "COALESCE(f.taken_at, f.created_at) DESC, f.name ASC"
	}
}

// hiddenClause maps a HiddenFilter to a fixed WHERE fragment (or empty string).
func (h HiddenFilter) hiddenClause() string {
	switch h {
	case HiddenInclude:
		return ""
	case HiddenOnly:
		return "AND f.hidden = TRUE"
	default: // HiddenExclude
		return "AND f.hidden = FALSE"
	}
}

// ListMediaFiles returns a page of files belonging to a media collection. This
// is the union of files physically in the collection (folder_id = collectionID)
// and files pointed into it via collection_items, filtered by hidden state and
// ordered per sort. Must run inside a ForUser transaction (RLS scopes rows).
func (q *Queries) ListMediaFiles(ctx context.Context, collectionID uuid.UUID, sort MediaSort, hidden HiddenFilter, in PageInput) (*PageResult[models.File], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListMediaFiles: %w", err)
	}

	query := `
		SELECT` + fileColumns + `
		FROM files f
		WHERE (
			f.folder_id = $1
			OR f.id IN (SELECT file_id FROM collection_items WHERE collection_id = $1)
		)
		` + hidden.hiddenClause() + `
		ORDER BY ` + sort.orderClause() + `
		LIMIT $2 OFFSET $3`

	rows, err := q.db.QueryContext(ctx, query, collectionID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("ListMediaFiles: %w", err)
	}
	defer rows.Close()

	files := make([]models.File, 0)
	for rows.Next() {
		f, err := scanFileRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListMediaFiles scan: %w", err)
		}
		files = append(files, *f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListMediaFiles: %w", err)
	}
	return &PageResult[models.File]{
		Items:     files,
		NextToken: offsetNextToken(len(files), limit, offset),
	}, nil
}

// SetFileHidden toggles a file's hidden flag and returns the updated record.
func (q *Queries) SetFileHidden(ctx context.Context, id uuid.UUID, hidden bool) (*models.File, error) {
	row := q.db.QueryRowContext(ctx, `
		UPDATE files SET hidden = $2, updated_at = NOW()
		WHERE id = $1
		RETURNING`+fileColumns,
		id, hidden)
	f, err := scanFile(row)
	if err != nil {
		return nil, fmt.Errorf("SetFileHidden %s: %w", id, err)
	}
	return f, nil
}

// SetFileTakenAt records the capture date extracted from media metadata.
// Runs outside the user-scoped transaction (called from background extraction),
// so it is intentionally not gated by RLS — file ids are unguessable UUIDs.
func (q *Queries) SetFileTakenAt(ctx context.Context, id uuid.UUID, takenAt time.Time) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE files SET taken_at = $2 WHERE id = $1
	`, id, takenAt)
	if err != nil {
		return fmt.Errorf("SetFileTakenAt %s: %w", id, err)
	}
	return nil
}
