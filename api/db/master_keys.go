package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"apollo-sfs.com/api/models"
)

func scanMasterKey(row *sql.Row) (*models.MasterKey, error) {
	var k models.MasterKey
	var retiredAt, deletedAt sql.NullTime
	err := row.Scan(
		&k.ID, &k.EncryptedKeyMaterial, &k.KeyNonce,
		&k.Status, &k.CreatedAt, &retiredAt, &deletedAt,
	)
	if err != nil {
		return nil, err
	}
	if retiredAt.Valid {
		k.RetiredAt = &retiredAt.Time
	}
	if deletedAt.Valid {
		k.DeletedAt = &deletedAt.Time
	}
	return &k, nil
}

// GetActiveMasterKey returns the single key with status "active".
// Returns sql.ErrNoRows if no active key exists (startup error condition).
func (q *Queries) GetActiveMasterKey(ctx context.Context) (*models.MasterKey, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT id, encrypted_key_material, key_nonce, status, created_at, retired_at, deleted_at
		FROM master_keys WHERE status = $1
	`, models.MasterKeyStatusActive)
	k, err := scanMasterKey(row)
	if err != nil {
		return nil, fmt.Errorf("GetActiveMasterKey: %w", err)
	}
	return k, nil
}

// CreateMasterKey inserts a new master key row.
func (q *Queries) CreateMasterKey(ctx context.Context, k *models.MasterKey) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO master_keys (id, encrypted_key_material, key_nonce, status, created_at)
		VALUES ($1, $2, $3, $4, NOW())
	`, k.ID, k.EncryptedKeyMaterial, k.KeyNonce, k.Status)
	if err != nil {
		return fmt.Errorf("CreateMasterKey %q: %w", k.ID, err)
	}
	return nil
}

// RetireMasterKey sets the key's status to "retiring" and stamps retired_at.
func (q *Queries) RetireMasterKey(ctx context.Context, id string, retiredAt time.Time) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE master_keys SET status = $2, retired_at = $3 WHERE id = $1`,
		id, models.MasterKeyStatusRetiring, retiredAt,
	)
	if err != nil {
		return fmt.Errorf("RetireMasterKey %q: %w", id, err)
	}
	return nil
}

// PurgeMasterKey zeros key material and marks the key as "deleted".
// The metadata row (id, version, timestamps) is kept for audit purposes.
func (q *Queries) PurgeMasterKey(ctx context.Context, id string, deletedAt time.Time) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE master_keys
		SET status = $2, deleted_at = $3,
		    encrypted_key_material = NULL, key_nonce = NULL
		WHERE id = $1
	`, id, models.MasterKeyStatusDeleted, deletedAt)
	if err != nil {
		return fmt.Errorf("PurgeMasterKey %q: %w", id, err)
	}
	return nil
}

// ListMasterKeysByStatus returns all master key rows with the given status.
// Used at startup to load retiring keys for the rotation overlap window.
func (q *Queries) ListMasterKeysByStatus(ctx context.Context, status models.MasterKeyStatus) ([]*models.MasterKey, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT id, encrypted_key_material, key_nonce, status, created_at, retired_at, deleted_at
		FROM master_keys WHERE status = $1
	`, status)
	if err != nil {
		return nil, fmt.Errorf("ListMasterKeysByStatus: %w", err)
	}
	defer rows.Close()

	var keys []*models.MasterKey
	for rows.Next() {
		var k models.MasterKey
		var retiredAt, deletedAt sql.NullTime
		if err := rows.Scan(&k.ID, &k.EncryptedKeyMaterial, &k.KeyNonce, &k.Status, &k.CreatedAt, &retiredAt, &deletedAt); err != nil {
			return nil, fmt.Errorf("ListMasterKeysByStatus scan: %w", err)
		}
		if retiredAt.Valid {
			k.RetiredAt = &retiredAt.Time
		}
		if deletedAt.Valid {
			k.DeletedAt = &deletedAt.Time
		}
		keys = append(keys, &k)
	}
	return keys, rows.Err()
}

// CreateKeyRotationLog inserts a rotation event and returns the generated log ID.
// Status is initially set to "failed" so any crash mid-rotation is self-documenting.
func (q *Queries) CreateKeyRotationLog(ctx context.Context, oldVer, newVer string) (string, error) {
	var id string
	err := q.db.QueryRowContext(ctx, `
		INSERT INTO key_rotation_log (
			id, old_key_version, new_key_version, users_rewrapped,
			started_at, status
		) VALUES (gen_random_uuid(), $1, $2, 0, NOW(), $3)
		RETURNING id::text
	`, oldVer, newVer, models.KeyRotationStatusFailed).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("CreateKeyRotationLog: %w", err)
	}
	return id, nil
}

// CompleteKeyRotationLog updates the rotation record once the process finishes
// (success or failure).
func (q *Queries) CompleteKeyRotationLog(
	ctx context.Context,
	id string,
	status models.KeyRotationStatus,
	usersRewrapped int,
	completedAt time.Time,
	errMsg *string,
) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE key_rotation_log
		SET status = $2, users_rewrapped = $3, completed_at = $4, error = $5
		WHERE id = $1
	`, id, status, usersRewrapped, completedAt, errMsg)
	if err != nil {
		return fmt.Errorf("CompleteKeyRotationLog %s: %w", id, err)
	}
	return nil
}
