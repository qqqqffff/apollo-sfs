package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

func scanFolder(row *sql.Row) (*models.Folder, error) {
	var f models.Folder
	var parentID uuid.NullUUID
	err := row.Scan(&f.ID, &f.UserID, &parentID, &f.Name, &f.CreatedAt, &f.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if parentID.Valid {
		f.ParentID = &parentID.UUID
	}
	return &f, nil
}

func scanFolderRow(rows *sql.Rows) (*models.Folder, error) {
	var f models.Folder
	var parentID uuid.NullUUID
	err := rows.Scan(&f.ID, &f.UserID, &parentID, &f.Name, &f.CreatedAt, &f.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if parentID.Valid {
		f.ParentID = &parentID.UUID
	}
	return &f, nil
}

// CreateFolder inserts a new folder and returns the persisted row with
// server-generated id and timestamps.
func (q *Queries) CreateFolder(ctx context.Context, f *models.Folder) (*models.Folder, error) {
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO folders (id, user_id, parent_id, name, created_at, updated_at)
		VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
		RETURNING id, user_id, parent_id, name, created_at, updated_at
	`, f.UserID, f.ParentID, f.Name)
	out, err := scanFolder(row)
	if err != nil {
		return nil, fmt.Errorf("CreateFolder: %w", err)
	}
	return out, nil
}

// GetFolderByID returns a single folder. Returns sql.ErrNoRows if not found.
func (q *Queries) GetFolderByID(ctx context.Context, id uuid.UUID) (*models.Folder, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT id, user_id, parent_id, name, created_at, updated_at
		FROM folders WHERE id = $1
	`, id)
	f, err := scanFolder(row)
	if err != nil {
		return nil, fmt.Errorf("GetFolderByID %s: %w", id, err)
	}
	return f, nil
}

// ListFoldersByUser returns a page of folders owned by userID, ordered by name.
// Secondary index: folders.user_id should be indexed in the DB migration.
func (q *Queries) ListFoldersByUser(ctx context.Context, userID uuid.UUID, in PageInput) (*PageResult[models.Folder], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListFoldersByUser: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, `
		SELECT id, user_id, parent_id, name, created_at, updated_at
		FROM folders WHERE user_id = $1
		ORDER BY name ASC
		LIMIT $2 OFFSET $3
	`, userID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("ListFoldersByUser: %w", err)
	}
	defer rows.Close()

	var folders []models.Folder
	for rows.Next() {
		f, err := scanFolderRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListFoldersByUser scan: %w", err)
		}
		folders = append(folders, *f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListFoldersByUser: %w", err)
	}
	return &PageResult[models.Folder]{
		Items:     folders,
		NextToken: offsetNextToken(len(folders), limit, offset),
	}, nil
}

// UpdateFolderName renames a folder and bumps updated_at.
// Returns the updated folder.
func (q *Queries) UpdateFolderName(ctx context.Context, id uuid.UUID, name string) (*models.Folder, error) {
	row := q.db.QueryRowContext(ctx, `
		UPDATE folders SET name = $2, updated_at = NOW()
		WHERE id = $1
		RETURNING id, user_id, parent_id, name, created_at, updated_at
	`, id, name)
	f, err := scanFolder(row)
	if err != nil {
		return nil, fmt.Errorf("UpdateFolderName %s: %w", id, err)
	}
	return f, nil
}

// ListRootFolders returns a page of top-level folders (parent_id IS NULL)
// owned by userID, ordered by name.
func (q *Queries) ListRootFolders(ctx context.Context, userID uuid.UUID, in PageInput) (*PageResult[models.Folder], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListRootFolders: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, `
		SELECT id, user_id, parent_id, name, created_at, updated_at
		FROM folders
		WHERE user_id = $1 AND parent_id IS NULL
		ORDER BY name ASC
		LIMIT $2 OFFSET $3
	`, userID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("ListRootFolders: %w", err)
	}
	defer rows.Close()

	var folders []models.Folder
	for rows.Next() {
		f, err := scanFolderRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListRootFolders scan: %w", err)
		}
		folders = append(folders, *f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListRootFolders: %w", err)
	}
	return &PageResult[models.Folder]{
		Items:     folders,
		NextToken: offsetNextToken(len(folders), limit, offset),
	}, nil
}

// SearchFoldersByUser returns a page of folders owned by userID whose name
// contains term (case-insensitive), ordered by name. Searches across all
// folders regardless of parent — intended for the global search endpoint.
func (q *Queries) SearchFoldersByUser(ctx context.Context, userID uuid.UUID, term string, in PageInput) (*PageResult[models.Folder], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("SearchFoldersByUser: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, `
		SELECT id, user_id, parent_id, name, created_at, updated_at
		FROM folders
		WHERE user_id = $1 AND name ILIKE '%' || $2 || '%'
		ORDER BY name ASC
		LIMIT $3 OFFSET $4
	`, userID, term, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("SearchFoldersByUser: %w", err)
	}
	defer rows.Close()

	var folders []models.Folder
	for rows.Next() {
		f, err := scanFolderRow(rows)
		if err != nil {
			return nil, fmt.Errorf("SearchFoldersByUser scan: %w", err)
		}
		folders = append(folders, *f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("SearchFoldersByUser: %w", err)
	}
	return &PageResult[models.Folder]{
		Items:     folders,
		NextToken: offsetNextToken(len(folders), limit, offset),
	}, nil
}

// ListFoldersByParent returns a page of direct child folders of parentID
// owned by userID, ordered by name.
func (q *Queries) ListFoldersByParent(ctx context.Context, userID, parentID uuid.UUID, in PageInput) (*PageResult[models.Folder], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListFoldersByParent: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, `
		SELECT id, user_id, parent_id, name, created_at, updated_at
		FROM folders
		WHERE user_id = $1 AND parent_id = $2
		ORDER BY name ASC
		LIMIT $3 OFFSET $4
	`, userID, parentID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("ListFoldersByParent: %w", err)
	}
	defer rows.Close()

	var folders []models.Folder
	for rows.Next() {
		f, err := scanFolderRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListFoldersByParent scan: %w", err)
		}
		folders = append(folders, *f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListFoldersByParent: %w", err)
	}
	return &PageResult[models.Folder]{
		Items:     folders,
		NextToken: offsetNextToken(len(folders), limit, offset),
	}, nil
}

// HasFolderChildren returns true if folderID contains any child folders or
// files. Used to block deletion of non-empty folders.
func (q *Queries) HasFolderChildren(ctx context.Context, folderID uuid.UUID) (bool, error) {
	var total int
	err := q.db.QueryRowContext(ctx, `
		SELECT
			(SELECT COUNT(*) FROM folders WHERE parent_id = $1) +
			(SELECT COUNT(*) FROM files   WHERE folder_id = $1)
	`, folderID).Scan(&total)
	if err != nil {
		return false, fmt.Errorf("HasFolderChildren %s: %w", folderID, err)
	}
	return total > 0, nil
}

// DeleteFolder removes a folder by id.
func (q *Queries) DeleteFolder(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `DELETE FROM folders WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("DeleteFolder %s: %w", id, err)
	}
	return nil
}
