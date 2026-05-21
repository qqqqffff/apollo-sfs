package db

import (
	"context"
	"database/sql"
	"fmt"

	"apollo-sfs.com/api/models"
)

const userColumns = `
	username, email, encrypted_key, key_nonce, master_key_version,
	storage_used_bytes, storage_quota_bytes, last_seen_at, created_at, is_admin`

func scanUser(row *sql.Row) (*models.User, error) {
	var u models.User
	var lastSeenAt sql.NullTime
	err := row.Scan(
		&u.Username, &u.Email, &u.EncryptedKey, &u.KeyNonce, &u.MasterKeyVersion,
		&u.StorageUsedBytes, &u.StorageQuotaBytes, &lastSeenAt, &u.CreatedAt, &u.IsAdmin,
	)
	if err != nil {
		return nil, err
	}
	if lastSeenAt.Valid {
		u.LastSeenAt = &lastSeenAt.Time
	}
	return &u, nil
}

func scanUserRow(rows *sql.Rows) (*models.User, error) {
	var u models.User
	var lastSeenAt sql.NullTime
	err := rows.Scan(
		&u.Username, &u.Email, &u.EncryptedKey, &u.KeyNonce, &u.MasterKeyVersion,
		&u.StorageUsedBytes, &u.StorageQuotaBytes, &lastSeenAt, &u.CreatedAt, &u.IsAdmin,
	)
	if err != nil {
		return nil, err
	}
	if lastSeenAt.Valid {
		u.LastSeenAt = &lastSeenAt.Time
	}
	return &u, nil
}

// GetUserByUsername returns a user by their unique username.
// Returns sql.ErrNoRows if the user does not exist.
func (q *Queries) GetUserByUsername(ctx context.Context, username string) (*models.User, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT`+userColumns+`
		FROM users WHERE username = $1
	`, username)
	u, err := scanUser(row)
	if err != nil {
		return nil, fmt.Errorf("GetUserByUsername %q: %w", username, err)
	}
	return u, nil
}

// CreateUser inserts a new user row. The caller is responsible for generating
// the encrypted_key and key_nonce before calling this.
func (q *Queries) CreateUser(ctx context.Context, u *models.User) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO users (
			username, email, encrypted_key, key_nonce, master_key_version,
			storage_used_bytes, storage_quota_bytes, created_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
	`, u.Username, u.Email, u.EncryptedKey, u.KeyNonce, u.MasterKeyVersion,
		u.StorageUsedBytes, u.StorageQuotaBytes,
	)
	if err != nil {
		return fmt.Errorf("CreateUser %q: %w", u.Username, err)
	}
	return nil
}

// ListUsers returns a page of registered users ordered by creation time descending.
func (q *Queries) ListUsers(ctx context.Context, in PageInput) (*PageResult[models.User], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListUsers: %w", err)
	}

	// Include each user's active ban (if any) via a lateral join.
	// Columns are fully qualified with u. to avoid ambiguity with user_bans.username.
	rows, err := q.db.QueryContext(ctx, `
		SELECT u.username, u.email, u.encrypted_key, u.key_nonce, u.master_key_version,
		       u.storage_used_bytes, u.storage_quota_bytes, u.last_seen_at, u.created_at, u.is_admin,
		       b.id, b.ban_type, b.violation_code, b.comments, b.banned_by,
		       b.banned_at, b.expires_at, b.pardoned_at, b.pardoned_by
		FROM   users u
		LEFT JOIN LATERAL (
		  SELECT * FROM user_bans
		  WHERE  username   = u.username
		    AND  pardoned_at IS NULL
		  ORDER  BY banned_at DESC
		  LIMIT  1
		) b ON TRUE
		ORDER BY u.created_at DESC
		LIMIT $1 OFFSET $2
	`, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("ListUsers: %w", err)
	}
	defer rows.Close()

	var users []models.User
	for rows.Next() {
		u, err := scanUserWithBanRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListUsers scan: %w", err)
		}
		users = append(users, *u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListUsers: %w", err)
	}
	return &PageResult[models.User]{
		Items:     users,
		NextToken: offsetNextToken(len(users), limit, offset),
	}, nil
}

func scanUserWithBanRow(rows *sql.Rows) (*models.User, error) {
	var u models.User
	var lastSeenAt sql.NullTime
	// Ban columns — all nullable because of the LEFT JOIN.
	var (
		banID            sql.NullInt64
		banType          sql.NullString
		violationCode    sql.NullString
		comments         sql.NullString
		bannedBy         sql.NullString
		bannedAt         sql.NullTime
		expiresAt        sql.NullTime
		pardonedAt       sql.NullTime
		pardonedBy       sql.NullString
	)
	err := rows.Scan(
		&u.Username, &u.Email, &u.EncryptedKey, &u.KeyNonce, &u.MasterKeyVersion,
		&u.StorageUsedBytes, &u.StorageQuotaBytes, &lastSeenAt, &u.CreatedAt, &u.IsAdmin,
		&banID, &banType, &violationCode, &comments, &bannedBy,
		&bannedAt, &expiresAt, &pardonedAt, &pardonedBy,
	)
	if err != nil {
		return nil, err
	}
	if lastSeenAt.Valid {
		u.LastSeenAt = &lastSeenAt.Time
	}
	if banID.Valid {
		b := &models.UserBan{
			ID:            banID.Int64,
			Username:      u.Username,
			BanType:       banType.String,
			ViolationCode: violationCode.String,
			Comments:      comments.String,
			BannedBy:      bannedBy.String,
			BannedAt:      bannedAt.Time,
		}
		if expiresAt.Valid {
			b.ExpiresAt = &expiresAt.Time
		}
		if pardonedAt.Valid {
			b.PardonedAt = &pardonedAt.Time
		}
		if pardonedBy.Valid {
			b.PardonedBy = &pardonedBy.String
		}
		u.ActiveBan = b
	}
	return &u, nil
}

// UpdateLastSeenAt stamps the current time and syncs is_admin from the JWT.
// Called by the auth middleware on every authenticated request.
func (q *Queries) UpdateLastSeenAt(ctx context.Context, username string, isAdmin bool) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE users SET last_seen_at = NOW(), is_admin = $2 WHERE username = $1`,
		username, isAdmin,
	)
	if err != nil {
		return fmt.Errorf("UpdateLastSeenAt %q: %w", username, err)
	}
	return nil
}

// UpdateUsername renames a user in the app DB. The caller must also rename the
// user in Keycloak so the preferred_username claim stays in sync.
func (q *Queries) UpdateUsername(ctx context.Context, oldUsername, newUsername string) error {
	res, err := q.db.ExecContext(ctx,
		`UPDATE users SET username = $2 WHERE username = $1`,
		oldUsername, newUsername,
	)
	if err != nil {
		return fmt.Errorf("UpdateUsername %q→%q: %w", oldUsername, newUsername, err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("UpdateUsername: user %q not found", oldUsername)
	}
	return nil
}

// AddStorageUsed atomically adjusts storage_used_bytes by delta (negative to subtract).
// Used after a file upload (+size) or deletion (-size).
func (q *Queries) AddStorageUsed(ctx context.Context, username string, delta int64) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE users SET storage_used_bytes = storage_used_bytes + $2 WHERE username = $1`,
		username, delta,
	)
	if err != nil {
		return fmt.Errorf("AddStorageUsed %q: %w", username, err)
	}
	return nil
}

// ListUsersOnKeyVersion returns a page of users whose encryption key is still
// wrapped under the given master key version. Used during key rotation to
// identify users that have not yet been re-wrapped.
func (q *Queries) ListUsersOnKeyVersion(ctx context.Context, version string, p PageInput) (*PageResult[models.User], error) {
	limit := clampLimit(p.Limit)
	offset, err := decodeOffsetCursor(p.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListUsersOnKeyVersion: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, `
		SELECT`+userColumns+`
		FROM users
		WHERE master_key_version = $1
		ORDER BY created_at ASC
		LIMIT $2 OFFSET $3
	`, version, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("ListUsersOnKeyVersion: %w", err)
	}
	defer rows.Close()

	var users []models.User
	for rows.Next() {
		u, err := scanUserRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListUsersOnKeyVersion scan: %w", err)
		}
		users = append(users, *u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListUsersOnKeyVersion: %w", err)
	}
	return &PageResult[models.User]{
		Items:     users,
		NextToken: offsetNextToken(len(users), limit, offset),
	}, nil
}

// UpdateUserEncryptionKey replaces a user's wrapped encryption key, nonce, and
// master key version in a single update. Called during key rotation re-wrap.
func (q *Queries) UpdateUserEncryptionKey(ctx context.Context, username string, encKey, nonce []byte, masterKeyVersion string) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE users
		SET encrypted_key = $2, key_nonce = $3, master_key_version = $4
		WHERE username = $1
	`, username, encKey, nonce, masterKeyVersion)
	if err != nil {
		return fmt.Errorf("UpdateUserEncryptionKey %q: %w", username, err)
	}
	return nil
}

// CountUsersByKeyVersion returns the number of users still on the given master
// key version. Used to verify that re-wrapping is complete before purging the
// old key.
func (q *Queries) CountUsersByKeyVersion(ctx context.Context, version string) (int, error) {
	var n int
	err := q.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM users WHERE master_key_version = $1`,
		version,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("CountUsersByKeyVersion: %w", err)
	}
	return n, nil
}

// UserStats holds aggregated values sampled once per metrics snapshot.
type UserStats struct {
	TotalUsers        int
	ActiveUsersLast5m int
	StorageUsedBytes  int64
	StorageQuotaBytes int64
}

// GetUserStats returns aggregate storage totals and user counts in a single
// query. Called every 5 seconds by the metrics sampler; uses COALESCE so it
// returns zeros on an empty users table.
func (q *Queries) GetUserStats(ctx context.Context) (*UserStats, error) {
	var s UserStats
	err := q.db.QueryRowContext(ctx, `
		SELECT
			COUNT(*)                                                          AS total_users,
			COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '5 minutes') AS active_users,
			COALESCE(SUM(storage_used_bytes),  0)                            AS storage_used,
			COALESCE(SUM(storage_quota_bytes), 0)                            AS storage_quota
		FROM users
	`).Scan(&s.TotalUsers, &s.ActiveUsersLast5m, &s.StorageUsedBytes, &s.StorageQuotaBytes)
	if err != nil {
		return nil, fmt.Errorf("GetUserStats: %w", err)
	}
	return &s, nil
}

// UpdateUserQuota sets a new storage_quota_bytes for the given user.
// Admin-only operation.
func (q *Queries) UpdateUserQuota(ctx context.Context, username string, quotaBytes int64) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE users SET storage_quota_bytes = $2 WHERE username = $1`,
		username, quotaBytes,
	)
	if err != nil {
		return fmt.Errorf("UpdateUserQuota %q: %w", username, err)
	}
	return nil
}

// ResetUserStorage sets storage_used_bytes = 0 and storage_quota_bytes = 0.
// Used after all user files are deleted on a permanent ban.
func (q *Queries) ResetUserStorage(ctx context.Context, username string) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE users SET storage_used_bytes = 0, storage_quota_bytes = 0 WHERE username = $1`,
		username,
	)
	if err != nil {
		return fmt.Errorf("ResetUserStorage %q: %w", username, err)
	}
	return nil
}
