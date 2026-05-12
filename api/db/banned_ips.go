package db

import (
	"context"
	"database/sql"
	"fmt"

	"apollo-sfs.com/api/models"
)

// ListBannedIPs returns a page of banned_ips rows ordered by banned_at DESC.
// When activeOnly is true only rows with unbanned_at IS NULL are returned.
func (q *Queries) ListBannedIPs(ctx context.Context, activeOnly bool, in PageInput) (*PageResult[models.BannedIP], error) {
	limit := clampLimit(in.Limit)
	before, err := decodeTimeCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListBannedIPs: %w", err)
	}

	var rows *sql.Rows
	if activeOnly {
		if before.IsZero() {
			rows, err = q.db.QueryContext(ctx, `
				SELECT id, ip::text, jail, banned_at, unbanned_at, ban_count
				FROM banned_ips
				WHERE unbanned_at IS NULL
				ORDER BY banned_at DESC
				LIMIT $1
			`, limit)
		} else {
			rows, err = q.db.QueryContext(ctx, `
				SELECT id, ip::text, jail, banned_at, unbanned_at, ban_count
				FROM banned_ips
				WHERE unbanned_at IS NULL
				  AND banned_at < $2
				ORDER BY banned_at DESC
				LIMIT $1
			`, limit, before)
		}
	} else {
		if before.IsZero() {
			rows, err = q.db.QueryContext(ctx, `
				SELECT id, ip::text, jail, banned_at, unbanned_at, ban_count
				FROM banned_ips
				ORDER BY banned_at DESC
				LIMIT $1
			`, limit)
		} else {
			rows, err = q.db.QueryContext(ctx, `
				SELECT id, ip::text, jail, banned_at, unbanned_at, ban_count
				FROM banned_ips
				WHERE banned_at < $2
				ORDER BY banned_at DESC
				LIMIT $1
			`, limit, before)
		}
	}
	if err != nil {
		return nil, fmt.Errorf("ListBannedIPs: %w", err)
	}
	defer rows.Close()

	bans := make([]models.BannedIP, 0)
	for rows.Next() {
		var b models.BannedIP
		if err := rows.Scan(&b.ID, &b.IP, &b.Jail, &b.BannedAt, &b.UnbannedAt, &b.BanCount); err != nil {
			return nil, fmt.Errorf("ListBannedIPs scan: %w", err)
		}
		bans = append(bans, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListBannedIPs: %w", err)
	}

	var nextToken string
	if len(bans) == limit {
		nextToken = encodeTimeCursor(bans[len(bans)-1].BannedAt)
	}
	return &PageResult[models.BannedIP]{Items: bans, NextToken: nextToken}, nil
}

// UnbanIP sets unbanned_at = NOW() for the given row.
func (q *Queries) UnbanIP(ctx context.Context, id int64) error {
	res, err := q.db.ExecContext(ctx,
		`UPDATE banned_ips SET unbanned_at = NOW() WHERE id = $1 AND unbanned_at IS NULL`,
		id,
	)
	if err != nil {
		return fmt.Errorf("UnbanIP: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// ExtendBan resets banned_at to NOW(), clears unbanned_at, and increments
// ban_count — effectively re-banning the IP in the audit record.
func (q *Queries) ExtendBan(ctx context.Context, id int64) error {
	res, err := q.db.ExecContext(ctx, `
		UPDATE banned_ips
		SET banned_at   = NOW(),
		    unbanned_at = NULL,
		    ban_count   = ban_count + 1
		WHERE id = $1
	`, id)
	if err != nil {
		return fmt.Errorf("ExtendBan: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return sql.ErrNoRows
	}
	return nil
}
