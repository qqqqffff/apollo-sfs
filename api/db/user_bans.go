package db

import (
	"context"
	"database/sql"
	"fmt"

	"apollo-sfs.com/api/models"
)

type CreateBanParams struct {
	Username      string
	BanType       string // "banned" | "suspended"
	ViolationCode string
	Comments      string
	BannedBy      string
	ExpiresAt     *string // RFC3339 timestamp; nil for permanent bans
}

// GetActiveBan returns the most recent active (non-pardoned) ban for username,
// or (nil, nil) when no active ban exists.
func (q *Queries) GetActiveBan(ctx context.Context, username string) (*models.UserBan, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT id, username, ban_type, violation_code, comments, banned_by,
		       banned_at, expires_at, pardoned_at, pardoned_by
		FROM   user_bans
		WHERE  username    = $1
		  AND  pardoned_at IS NULL
		ORDER  BY banned_at DESC
		LIMIT  1
	`, username)
	return scanUserBan(row)
}

// CreateBan inserts a new ban or suspension record and returns it.
func (q *Queries) CreateBan(ctx context.Context, p CreateBanParams) (*models.UserBan, error) {
	var row *sql.Row
	if p.ExpiresAt != nil {
		row = q.db.QueryRowContext(ctx, `
			INSERT INTO user_bans
			  (username, ban_type, violation_code, comments, banned_by, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
			RETURNING id, username, ban_type, violation_code, comments, banned_by,
			          banned_at, expires_at, pardoned_at, pardoned_by
		`, p.Username, p.BanType, p.ViolationCode, p.Comments, p.BannedBy, *p.ExpiresAt)
	} else {
		row = q.db.QueryRowContext(ctx, `
			INSERT INTO user_bans
			  (username, ban_type, violation_code, comments, banned_by)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, username, ban_type, violation_code, comments, banned_by,
			          banned_at, expires_at, pardoned_at, pardoned_by
		`, p.Username, p.BanType, p.ViolationCode, p.Comments, p.BannedBy)
	}
	return scanUserBan(row)
}

// PardonBan sets pardoned_at = NOW() for the given ban record.
func (q *Queries) PardonBan(ctx context.Context, id int64, pardonedBy string) error {
	res, err := q.db.ExecContext(ctx,
		`UPDATE user_bans SET pardoned_at = NOW(), pardoned_by = $2
		 WHERE id = $1 AND pardoned_at IS NULL`,
		id, pardonedBy,
	)
	if err != nil {
		return fmt.Errorf("PardonBan: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// PardonAllActiveBans pardons every active ban record for a username.
func (q *Queries) PardonAllActiveBans(ctx context.Context, username, pardonedBy string) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE user_bans SET pardoned_at = NOW(), pardoned_by = $2
		 WHERE username = $1 AND pardoned_at IS NULL`,
		username, pardonedBy,
	)
	if err != nil {
		return fmt.Errorf("PardonAllActiveBans: %w", err)
	}
	return nil
}

// AutoPardonExpiredSuspension pardons any expired suspension for username.
// Returns nil (not an error) when no expired suspension exists.
func (q *Queries) AutoPardonExpiredSuspension(ctx context.Context, username string) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE user_bans
		SET    pardoned_at = NOW(), pardoned_by = 'system'
		WHERE  username    = $1
		  AND  ban_type    = 'suspended'
		  AND  pardoned_at IS NULL
		  AND  expires_at  IS NOT NULL
		  AND  expires_at  <= NOW()
	`, username)
	if err != nil {
		return fmt.Errorf("AutoPardonExpiredSuspension: %w", err)
	}
	return nil
}

// ListUserBans returns a page of ban records, optionally filtered to active only.
// Results are ordered by banned_at DESC.
func (q *Queries) ListUserBans(ctx context.Context, activeOnly bool, in PageInput) (*PageResult[models.UserBan], error) {
	limit := clampLimit(in.Limit)
	before, err := decodeTimeCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListUserBans: %w", err)
	}

	cols := `id, username, ban_type, violation_code, comments, banned_by,
	         banned_at, expires_at, pardoned_at, pardoned_by`

	var rows *sql.Rows
	if activeOnly {
		if before.IsZero() {
			rows, err = q.db.QueryContext(ctx, `
				SELECT `+cols+`
				FROM   user_bans
				WHERE  pardoned_at IS NULL
				ORDER  BY banned_at DESC
				LIMIT  $1
			`, limit)
		} else {
			rows, err = q.db.QueryContext(ctx, `
				SELECT `+cols+`
				FROM   user_bans
				WHERE  pardoned_at IS NULL
				  AND  banned_at < $2
				ORDER  BY banned_at DESC
				LIMIT  $1
			`, limit, before)
		}
	} else {
		if before.IsZero() {
			rows, err = q.db.QueryContext(ctx, `
				SELECT `+cols+`
				FROM   user_bans
				ORDER  BY banned_at DESC
				LIMIT  $1
			`, limit)
		} else {
			rows, err = q.db.QueryContext(ctx, `
				SELECT `+cols+`
				FROM   user_bans
				WHERE  banned_at < $2
				ORDER  BY banned_at DESC
				LIMIT  $1
			`, limit, before)
		}
	}
	if err != nil {
		return nil, fmt.Errorf("ListUserBans: %w", err)
	}
	defer rows.Close()

	bans := make([]models.UserBan, 0)
	for rows.Next() {
		b, err := scanUserBanRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListUserBans scan: %w", err)
		}
		bans = append(bans, *b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListUserBans: %w", err)
	}

	var nextToken string
	if len(bans) == limit {
		nextToken = encodeTimeCursor(bans[len(bans)-1].BannedAt)
	}
	return &PageResult[models.UserBan]{Items: bans, NextToken: nextToken}, nil
}

// ── Scan helpers ──────────────────────────────────────────────────────────────

func scanUserBan(row *sql.Row) (*models.UserBan, error) {
	var b models.UserBan
	var expiresAt, pardonedAt sql.NullTime
	var pardonedBy sql.NullString
	err := row.Scan(
		&b.ID, &b.Username, &b.BanType, &b.ViolationCode, &b.Comments, &b.BannedBy,
		&b.BannedAt, &expiresAt, &pardonedAt, &pardonedBy,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
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
	return &b, nil
}

func scanUserBanRow(rows *sql.Rows) (*models.UserBan, error) {
	var b models.UserBan
	var expiresAt, pardonedAt sql.NullTime
	var pardonedBy sql.NullString
	if err := rows.Scan(
		&b.ID, &b.Username, &b.BanType, &b.ViolationCode, &b.Comments, &b.BannedBy,
		&b.BannedAt, &expiresAt, &pardonedAt, &pardonedBy,
	); err != nil {
		return nil, err
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
	return &b, nil
}
