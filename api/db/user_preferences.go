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
// yet it returns a defaults record (with UserID set) and no error, so callers
// can treat "never configured" as "all defaults".
func (q *Queries) GetUserPreferences(ctx context.Context, userID string) (*models.UserPreferences, error) {
	var p models.UserPreferences
	var folderID uuid.NullUUID
	err := q.db.QueryRowContext(ctx, `
		SELECT user_id, media_autoupload_folder_id, show_storage_buttons,
		       storage_prompt_enabled, created_at, updated_at
		FROM user_preferences WHERE user_id = $1
	`, userID).Scan(&p.UserID, &folderID, &p.ShowStorageButtons,
		&p.StoragePromptEnabled, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return &models.UserPreferences{
			UserID:               userID,
			ShowStorageButtons:   true,
			StoragePromptEnabled: true,
		}, nil
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
		RETURNING user_id, media_autoupload_folder_id, show_storage_buttons,
		          storage_prompt_enabled, created_at, updated_at
	`, userID, nf).Scan(&p.UserID, &out, &p.ShowStorageButtons,
		&p.StoragePromptEnabled, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("SetMediaAutouploadFolder: %w", err)
	}
	if out.Valid {
		p.MediaAutouploadFolderID = &out.UUID
	}
	return &p, nil
}

// SetStorageUIPreferences upserts the storage upgrade UI toggles. Nil fields
// are left unchanged (or default to true when the row is first created).
func (q *Queries) SetStorageUIPreferences(ctx context.Context, userID string, showButtons, promptEnabled *bool) (*models.UserPreferences, error) {
	var p models.UserPreferences
	var folderID uuid.NullUUID
	err := q.db.QueryRowContext(ctx, `
		INSERT INTO user_preferences (user_id, show_storage_buttons, storage_prompt_enabled, created_at, updated_at)
		VALUES ($1, COALESCE($2, TRUE), COALESCE($3, TRUE), NOW(), NOW())
		ON CONFLICT (user_id) DO UPDATE
			SET show_storage_buttons   = COALESCE($2, user_preferences.show_storage_buttons),
			    storage_prompt_enabled = COALESCE($3, user_preferences.storage_prompt_enabled),
			    updated_at = NOW()
		RETURNING user_id, media_autoupload_folder_id, show_storage_buttons,
		          storage_prompt_enabled, created_at, updated_at
	`, userID, nullBool(showButtons), nullBool(promptEnabled)).Scan(
		&p.UserID, &folderID, &p.ShowStorageButtons,
		&p.StoragePromptEnabled, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("SetStorageUIPreferences: %w", err)
	}
	if folderID.Valid {
		p.MediaAutouploadFolderID = &folderID.UUID
	}
	return &p, nil
}

// SetBackupStaleNotify upserts the backup-reminder toggle: when enabled the
// notification bell warns the user once their most recent Google or email
// backup is more than 30 days old.
func (q *Queries) SetBackupStaleNotify(ctx context.Context, userID string, enabled bool) (*models.UserPreferences, error) {
	var p models.UserPreferences
	var folderID uuid.NullUUID
	err := q.db.QueryRowContext(ctx, `
		INSERT INTO user_preferences (user_id, backup_stale_notify, created_at, updated_at)
		VALUES ($1, $2, NOW(), NOW())
		ON CONFLICT (user_id) DO UPDATE
			SET backup_stale_notify = EXCLUDED.backup_stale_notify,
			    updated_at = NOW()
		RETURNING user_id, media_autoupload_folder_id, show_storage_buttons,
		          storage_prompt_enabled, backup_stale_notify, created_at, updated_at
	`, userID, enabled).Scan(&p.UserID, &folderID, &p.ShowStorageButtons,
		&p.StoragePromptEnabled, &p.BackupStaleNotify, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("SetBackupStaleNotify: %w", err)
	}
	if folderID.Valid {
		p.MediaAutouploadFolderID = &folderID.UUID
	}
	return &p, nil
}

func nullBool(b *bool) any {
	if b == nil {
		return nil
	}
	return *b
}
