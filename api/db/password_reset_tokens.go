package db

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// hashPasswordResetToken hashes a plaintext reset token for storage/comparison.
// The token is 32 bytes of CSPRNG output, so a plain SHA-256 (no per-row salt)
// is sufficient to keep replayable tokens out of the database — there is no
// low-entropy secret here to brute-force.
func hashPasswordResetToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// CreatePasswordResetToken invalidates any outstanding reset tokens for the user
// and stores a new hashed token with the given expiry.
func (q *Queries) CreatePasswordResetToken(ctx context.Context, username, token string, expiresAt time.Time) error {
	// One live token at a time: requesting a new reset link immediately kills
	// the previous one, so a link that leaked (forwarded mail, shared inbox)
	// stops working as soon as the real owner asks for another.
	if _, err := q.db.ExecContext(ctx, `
		UPDATE password_reset_tokens
		SET consumed_at = NOW()
		WHERE username = $1 AND consumed_at IS NULL
	`, username); err != nil {
		return fmt.Errorf("CreatePasswordResetToken invalidate: %w", err)
	}
	if _, err := q.db.ExecContext(ctx, `
		INSERT INTO password_reset_tokens (username, token_hash, expires_at)
		VALUES ($1, $2, $3)
	`, username, hashPasswordResetToken(token), expiresAt); err != nil {
		return fmt.Errorf("CreatePasswordResetToken insert: %w", err)
	}
	return nil
}

// ConsumePasswordResetToken atomically verifies and consumes a reset token,
// returning the username it was issued to. The token is the only credential the
// reset link carries, so the lookup is by hash alone.
//
// Returns ("", nil) when no matching, unexpired, unconsumed token exists —
// wrong, expired, or already-used. Marking it consumed in the same statement
// that reads it is what makes the token single-use even under concurrent
// requests.
func (q *Queries) ConsumePasswordResetToken(ctx context.Context, token string) (string, error) {
	var username string
	err := q.db.QueryRowContext(ctx, `
		UPDATE password_reset_tokens
		SET consumed_at = NOW()
		WHERE id = (
			SELECT id FROM password_reset_tokens
			WHERE token_hash = $1
			  AND consumed_at IS NULL
			  AND expires_at > NOW()
			LIMIT 1
		)
		RETURNING username
	`, hashPasswordResetToken(token)).Scan(&username)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("ConsumePasswordResetToken: %w", err)
	}
	return username, nil
}
