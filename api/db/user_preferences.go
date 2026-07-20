package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// prefColumns is the full projection returned by every preferences query so the
// returned models.UserPreferences is always fully populated (callers and the
// frontend cache rely on every field being present, not just the one mutated).
const prefColumns = `user_id, media_autoupload_folder_id, show_storage_buttons,
	storage_prompt_enabled, backup_stale_notify, default_drive_id, created_at, updated_at`

// scanPrefs scans a row projected with prefColumns into p.
func scanPrefs(row interface{ Scan(...any) error }, p *models.UserPreferences) error {
	var folderID, driveID uuid.NullUUID
	if err := row.Scan(&p.UserID, &folderID, &p.ShowStorageButtons,
		&p.StoragePromptEnabled, &p.BackupStaleNotify, &driveID,
		&p.CreatedAt, &p.UpdatedAt); err != nil {
		return err
	}
	if folderID.Valid {
		p.MediaAutouploadFolderID = &folderID.UUID
	}
	if driveID.Valid {
		p.DefaultDriveID = &driveID.UUID
	}
	return nil
}

// GetUserPreferences returns the preferences row for userID. If no row exists
// yet it returns a defaults record (with UserID set) and no error, so callers
// can treat "never configured" as "all defaults".
func (q *Queries) GetUserPreferences(ctx context.Context, userID string) (*models.UserPreferences, error) {
	var p models.UserPreferences
	err := scanPrefs(q.db.QueryRowContext(ctx, `
		SELECT `+prefColumns+`
		FROM user_preferences WHERE user_id = $1
	`, userID), &p)
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
	err := scanPrefs(q.db.QueryRowContext(ctx, `
		INSERT INTO user_preferences (user_id, media_autoupload_folder_id, created_at, updated_at)
		VALUES ($1, $2, NOW(), NOW())
		ON CONFLICT (user_id) DO UPDATE
			SET media_autoupload_folder_id = EXCLUDED.media_autoupload_folder_id,
			    updated_at = NOW()
		RETURNING `+prefColumns+`
	`, userID, nf), &p)
	if err != nil {
		return nil, fmt.Errorf("SetMediaAutouploadFolder: %w", err)
	}
	return &p, nil
}

// SetStorageUIPreferences upserts the storage upgrade UI toggles. Nil fields
// are left unchanged (or default to true when the row is first created).
func (q *Queries) SetStorageUIPreferences(ctx context.Context, userID string, showButtons, promptEnabled *bool) (*models.UserPreferences, error) {
	var p models.UserPreferences
	err := scanPrefs(q.db.QueryRowContext(ctx, `
		INSERT INTO user_preferences (user_id, show_storage_buttons, storage_prompt_enabled, created_at, updated_at)
		VALUES ($1, COALESCE($2, TRUE), COALESCE($3, TRUE), NOW(), NOW())
		ON CONFLICT (user_id) DO UPDATE
			SET show_storage_buttons   = COALESCE($2, user_preferences.show_storage_buttons),
			    storage_prompt_enabled = COALESCE($3, user_preferences.storage_prompt_enabled),
			    updated_at = NOW()
		RETURNING `+prefColumns+`
	`, userID, nullBool(showButtons), nullBool(promptEnabled)), &p)
	if err != nil {
		return nil, fmt.Errorf("SetStorageUIPreferences: %w", err)
	}
	return &p, nil
}

// SetBackupStaleNotify upserts the backup-reminder toggle: when enabled the
// notification bell warns the user once their most recent Google or email
// backup is more than 30 days old.
func (q *Queries) SetBackupStaleNotify(ctx context.Context, userID string, enabled bool) (*models.UserPreferences, error) {
	var p models.UserPreferences
	err := scanPrefs(q.db.QueryRowContext(ctx, `
		INSERT INTO user_preferences (user_id, backup_stale_notify, created_at, updated_at)
		VALUES ($1, $2, NOW(), NOW())
		ON CONFLICT (user_id) DO UPDATE
			SET backup_stale_notify = EXCLUDED.backup_stale_notify,
			    updated_at = NOW()
		RETURNING `+prefColumns+`
	`, userID, enabled), &p)
	if err != nil {
		return nil, fmt.Errorf("SetBackupStaleNotify: %w", err)
	}
	return &p, nil
}

// SetDefaultDrive upserts the user's default display drive (the server & tier
// whose view the browser lands on). Passing nil clears it. Callers must
// validate that driveID is one of the user's own allocations before calling.
func (q *Queries) SetDefaultDrive(ctx context.Context, userID string, driveID *uuid.UUID) (*models.UserPreferences, error) {
	var nd uuid.NullUUID
	if driveID != nil {
		nd = uuid.NullUUID{UUID: *driveID, Valid: true}
	}
	var p models.UserPreferences
	err := scanPrefs(q.db.QueryRowContext(ctx, `
		INSERT INTO user_preferences (user_id, default_drive_id, created_at, updated_at)
		VALUES ($1, $2, NOW(), NOW())
		ON CONFLICT (user_id) DO UPDATE
			SET default_drive_id = EXCLUDED.default_drive_id,
			    updated_at = NOW()
		RETURNING `+prefColumns+`
	`, userID, nd), &p)
	if err != nil {
		return nil, fmt.Errorf("SetDefaultDrive: %w", err)
	}
	return &p, nil
}

func nullBool(b *bool) any {
	if b == nil {
		return nil
	}
	return *b
}
