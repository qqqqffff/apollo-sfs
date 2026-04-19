package db

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// AddFileFavorite inserts a favorite row for a file. Returns a duplicate-key
// error (detectable via isDuplicateKeyError in the service layer) if the user
// has already favorited that file.
func (q *Queries) AddFileFavorite(ctx context.Context, userID, fileID uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO favorites (user_id, file_id)
		VALUES ($1, $2)
	`, userID, fileID)
	if err != nil {
		return fmt.Errorf("AddFileFavorite: %w", err)
	}
	return nil
}

// AddFolderFavorite inserts a favorite row for a folder. Returns a duplicate-key
// error if the user has already favorited that folder.
func (q *Queries) AddFolderFavorite(ctx context.Context, userID, folderID uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO favorites (user_id, folder_id)
		VALUES ($1, $2)
	`, userID, folderID)
	if err != nil {
		return fmt.Errorf("AddFolderFavorite: %w", err)
	}
	return nil
}

// RemoveFileFavorite deletes the favorite row for a file. A no-op if the row
// does not exist (not an error).
func (q *Queries) RemoveFileFavorite(ctx context.Context, userID, fileID uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		DELETE FROM favorites WHERE user_id = $1 AND file_id = $2
	`, userID, fileID)
	if err != nil {
		return fmt.Errorf("RemoveFileFavorite: %w", err)
	}
	return nil
}

// RemoveFolderFavorite deletes the favorite row for a folder. A no-op if the
// row does not exist (not an error).
func (q *Queries) RemoveFolderFavorite(ctx context.Context, userID, folderID uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		DELETE FROM favorites WHERE user_id = $1 AND folder_id = $2
	`, userID, folderID)
	if err != nil {
		return fmt.Errorf("RemoveFolderFavorite: %w", err)
	}
	return nil
}

// ListFavoritedFiles returns the full file records for all files the user has
// favorited, ordered by the time they were favorited (newest first).
func (q *Queries) ListFavoritedFiles(ctx context.Context, userID uuid.UUID) ([]models.File, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT f.id, f.user_id, f.folder_id, f.name, f.mime_type,
		       f.size_bytes, f.minio_object_key, f.nonce, f.created_at, f.updated_at
		FROM favorites fav
		JOIN files f ON f.id = fav.file_id
		WHERE fav.user_id = $1 AND fav.file_id IS NOT NULL
		ORDER BY fav.created_at DESC
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("ListFavoritedFiles: %w", err)
	}
	defer rows.Close()

	var files []models.File
	for rows.Next() {
		var f models.File
		if err := rows.Scan(
			&f.ID, &f.UserID, &f.FolderID, &f.Name, &f.MimeType,
			&f.SizeBytes, &f.MinIOObjectKey, &f.Nonce, &f.CreatedAt, &f.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("ListFavoritedFiles scan: %w", err)
		}
		files = append(files, f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListFavoritedFiles: %w", err)
	}
	return files, nil
}

// ListFavoritedFolders returns the full folder records for all folders the user
// has favorited, ordered by the time they were favorited (newest first).
func (q *Queries) ListFavoritedFolders(ctx context.Context, userID uuid.UUID) ([]models.Folder, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT fo.id, fo.user_id, fo.parent_id, fo.name, fo.created_at, fo.updated_at
		FROM favorites fav
		JOIN folders fo ON fo.id = fav.folder_id
		WHERE fav.user_id = $1 AND fav.folder_id IS NOT NULL
		ORDER BY fav.created_at DESC
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("ListFavoritedFolders: %w", err)
	}
	defer rows.Close()

	var folders []models.Folder
	for rows.Next() {
		var f models.Folder
		var parentID uuid.NullUUID
		if err := rows.Scan(&f.ID, &f.UserID, &parentID, &f.Name, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, fmt.Errorf("ListFavoritedFolders scan: %w", err)
		}
		if parentID.Valid {
			f.ParentID = &parentID.UUID
		}
		folders = append(folders, f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListFavoritedFolders: %w", err)
	}
	return folders, nil
}
