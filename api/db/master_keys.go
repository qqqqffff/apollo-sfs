package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"apollo-sfs.com/api/models"
)

// masterKeyBootstrapLockKey is an arbitrary constant used with
// pg_advisory_xact_lock to serialize concurrent first-boot bootstrap
// attempts (see BootstrapMasterKey). Any fixed int64 works; it just needs to
// be unique among this codebase's advisory lock keys.
const masterKeyBootstrapLockKey = 727100001

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

// BootstrapMasterKey inserts k as the first active master key, but only if no
// active key exists. It serializes concurrent callers (e.g. two containers
// briefly overlapping during a restart) with a Postgres advisory lock scoped
// to the transaction, then re-checks for an active key while holding it —
// otherwise two processes can both pass the "no active key yet" check before
// either has inserted, and the loser's INSERT violates
// master_keys_one_active_idx.
//
// If another process already won the race, that pre-existing key is
// returned with insertedNew=false and the caller should adopt it instead of
// the key material it generated (which was never stored). insertedNew=true
// means k itself was stored and should be used as-is.
func (q *Queries) BootstrapMasterKey(ctx context.Context, k *models.MasterKey) (winner *models.MasterKey, insertedNew bool, err error) {
	tx, err := q.pool.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, fmt.Errorf("BootstrapMasterKey: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, masterKeyBootstrapLockKey); err != nil {
		return nil, false, fmt.Errorf("BootstrapMasterKey: acquire lock: %w", err)
	}

	row := tx.QueryRowContext(ctx, `
		SELECT id, encrypted_key_material, key_nonce, status, created_at, retired_at, deleted_at
		FROM master_keys WHERE status = $1
	`, models.MasterKeyStatusActive)
	switch existing, scanErr := scanMasterKey(row); {
	case scanErr == nil:
		// Someone else already bootstrapped while we were waiting for the lock.
		if err := tx.Commit(); err != nil {
			return nil, false, fmt.Errorf("BootstrapMasterKey: commit (existing): %w", err)
		}
		return existing, false, nil
	case !errors.Is(scanErr, sql.ErrNoRows):
		return nil, false, fmt.Errorf("BootstrapMasterKey: check existing: %w", scanErr)
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO master_keys (id, encrypted_key_material, key_nonce, status, created_at)
		VALUES ($1, $2, $3, $4, NOW())
	`, k.ID, k.EncryptedKeyMaterial, k.KeyNonce, k.Status); err != nil {
		return nil, false, fmt.Errorf("BootstrapMasterKey: insert %q: %w", k.ID, err)
	}

	if err := tx.Commit(); err != nil {
		return nil, false, fmt.Errorf("BootstrapMasterKey: commit: %w", err)
	}
	return k, true, nil
}

// RetireAndCreateMasterKey retires the current active key and inserts the new
// key as "active" in a single transaction. The retire UPDATE must happen
// before the INSERT: master_keys_one_active_idx (a partial unique index on
// status = 'active') allows only one active row at a time, so creating the
// new active row while the old one is still active would violate it. Doing
// both in one transaction also avoids ever leaving zero active keys visible
// to other sessions (e.g. LoadMasterKeys on startup would otherwise mistake
// the gap for a first-boot state and bootstrap a fresh "v1").
func (q *Queries) RetireAndCreateMasterKey(ctx context.Context, oldID string, retiredAt time.Time, newKey *models.MasterKey) error {
	tx, err := q.pool.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("RetireAndCreateMasterKey: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx,
		`UPDATE master_keys SET status = $2, retired_at = $3 WHERE id = $1`,
		oldID, models.MasterKeyStatusRetiring, retiredAt,
	); err != nil {
		return fmt.Errorf("RetireAndCreateMasterKey: retire %q: %w", oldID, err)
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO master_keys (id, encrypted_key_material, key_nonce, status, created_at)
		VALUES ($1, $2, $3, $4, NOW())
	`, newKey.ID, newKey.EncryptedKeyMaterial, newKey.KeyNonce, newKey.Status); err != nil {
		return fmt.Errorf("RetireAndCreateMasterKey: create %q: %w", newKey.ID, err)
	}

	return tx.Commit()
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
