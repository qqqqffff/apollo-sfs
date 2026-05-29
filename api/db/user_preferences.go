package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// GetUserPreferences returns the preferences row for userID. If no row exists
// yet it returns a zero-value record (with UserID set) and no error, so callers
// can treat "never configured" as "all defaults".
func (q *Queries) GetUserPreferences(ctx context.Context, userID string) (*models.UserPreferences, error) {
	var p models.UserPreferences
	var folderID uuid.NullUUID
	err := q.db.QueryRowContext(ctx, `
		SELECT user_id, media_autoupload_folder_id, created_at, updated_at
		FROM user_preferences WHERE user_id = $1
	`, userID).Scan(&p.UserID, &folderID, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return &models.UserPreferences{UserID: userID}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetUserPreferences: %w", err)
	}
	if folderID.Valid {
		p.MediaAutouploadFolderID = &folderID.UUID
	}
	return &p, nil
}

// SetMediaAutouploadFolder upserts the user's media auto-upload target. Passing
// nil clears it (disables auto-upload routing).
func (q *Queries) SetMediaAutouploadFolder(ctx context.Context, userID string, folderID *uuid.UUID) (*models.UserPreferences, error) {
	var nf uuid.NullUUID
	if folderID != nil {
		nf = uuid.NullUUID{UUID: *folderID, Valid: true}
	}
	var p models.UserPreferences
	var out uuid.NullUUID
	err := q.db.QueryRowContext(ctx, `
		INSERT INTO user_preferences (user_id, media_autoupload_folder_id, created_at, updated_at)
		VALUES ($1, $2, NOW(), NOW())
		ON CONFLICT (user_id) DO UPDATE
			SET media_autoupload_folder_id = EXCLUDED.media_autoupload_folder_id,
			    updated_at = NOW()
		RETURNING user_id, media_autoupload_folder_id, created_at, updated_at
	`, userID, nf).Scan(&p.UserID, &out, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("SetMediaAutouploadFolder: %w", err)
	}
	if out.Valid {
		p.MediaAutouploadFolderID = &out.UUID
	}
	return &p, nil
}
