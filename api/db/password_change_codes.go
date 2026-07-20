package db

import (
	"context"
	"crypto/sha256"
	"fmt"
	"time"
)

// hashPasswordChangeCode hashes a plaintext code for storage/comparison. The
// code is short-lived and single-use, so a plain SHA-256 (no per-row salt) is
// sufficient to keep raw codes out of the database.
func hashPasswordChangeCode(code string) []byte {
	sum := sha256.Sum256([]byte(code))
	return sum[:]
}

// CreatePasswordChangeCode invalidates any outstanding codes for the user and
// stores a new hashed code with the given expiry. Returns the row id.
func (q *Queries) CreatePasswordChangeCode(ctx context.Context, username, code string, expiresAt time.Time) error {
	// One live code at a time: mark previous unconsumed codes as consumed so a
	// freshly issued code is the only one that can be redeemed.
	if _, err := q.db.ExecContext(ctx, `
		UPDATE password_change_codes
		SET consumed_at = NOW()
		WHERE username = $1 AND consumed_at IS NULL
	`, username); err != nil {
		return fmt.Errorf("CreatePasswordChangeCode invalidate: %w", err)
	}
	if _, err := q.db.ExecContext(ctx, `
		INSERT INTO password_change_codes (username, code_hash, expires_at)
		VALUES ($1, $2, $3)
	`, username, hashPasswordChangeCode(code), expiresAt); err != nil {
		return fmt.Errorf("CreatePasswordChangeCode insert: %w", err)
	}
	return nil
}

// ConsumePasswordChangeCode atomically verifies and consumes a code for the
// user. Returns true when a matching, unexpired, unconsumed code was found and
// marked consumed; false otherwise (wrong/expired/already-used code).
func (q *Queries) ConsumePasswordChangeCode(ctx context.Context, username, code string) (bool, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE password_change_codes
		SET consumed_at = NOW()
		WHERE id = (
			SELECT id FROM password_change_codes
			WHERE username = $1
			  AND code_hash = $2
			  AND consumed_at IS NULL
			  AND expires_at > NOW()
			ORDER BY created_at DESC
			LIMIT 1
		)
	`, username, hashPasswordChangeCode(code))
	if err != nil {
		return false, fmt.Errorf("ConsumePasswordChangeCode: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
