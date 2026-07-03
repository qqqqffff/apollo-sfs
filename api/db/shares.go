package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

const shareColumns = `
	id, token, owner_user_id, owner_username, recipient_email,
	file_id, folder_id, can_download, can_upload, include_children,
	revoked_at, created_at
`

func scanShareRow(scan func(dest ...any) error) (*models.Share, error) {
	var s models.Share
	var fileID, folderID uuid.NullUUID
	var revokedAt sql.NullTime
	if err := scan(
		&s.ID, &s.Token, &s.OwnerUserID, &s.OwnerUsername, &s.RecipientEmail,
		&fileID, &folderID, &s.CanDownload, &s.CanUpload, &s.IncludeChildren,
		&revokedAt, &s.CreatedAt,
	); err != nil {
		return nil, err
	}
	if fileID.Valid {
		s.FileID = &fileID.UUID
	}
	if folderID.Valid {
		s.FolderID = &folderID.UUID
	}
	if revokedAt.Valid {
		t := revokedAt.Time
		s.RevokedAt = &t
	}
	return &s, nil
}

// CreateShare inserts a share row and returns it with DB-assigned fields.
// A duplicate active share of the same object to the same recipient violates
// the shares_active_*_unique partial indexes (detectable via
// isDuplicateKeyError in the service layer).
func (q *Queries) CreateShare(ctx context.Context, s *models.Share) (*models.Share, error) {
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO shares (token, owner_user_id, owner_username, recipient_email,
		                    file_id, folder_id, can_download, can_upload, include_children)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING`+shareColumns,
		s.Token, s.OwnerUserID, s.OwnerUsername, s.RecipientEmail,
		s.FileID, s.FolderID, s.CanDownload, s.CanUpload, s.IncludeChildren,
	)
	created, err := scanShareRow(row.Scan)
	if err != nil {
		return nil, fmt.Errorf("CreateShare: %w", err)
	}
	return created, nil
}

// GetShareByID fetches a share by primary key. Returns sql.ErrNoRows when absent.
func (q *Queries) GetShareByID(ctx context.Context, id uuid.UUID) (*models.Share, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT`+shareColumns+`FROM shares WHERE id = $1
	`, id)
	s, err := scanShareRow(row.Scan)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, err
		}
		return nil, fmt.Errorf("GetShareByID: %w", err)
	}
	return s, nil
}

// GetShareByToken fetches a share by its link token. Returns sql.ErrNoRows when absent.
func (q *Queries) GetShareByToken(ctx context.Context, token string) (*models.Share, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT`+shareColumns+`FROM shares WHERE token = $1
	`, token)
	s, err := scanShareRow(row.Scan)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, err
		}
		return nil, fmt.Errorf("GetShareByToken: %w", err)
	}
	return s, nil
}

// ListSharesByOwner returns the owner's active (non-revoked) shares, newest first.
func (q *Queries) ListSharesByOwner(ctx context.Context, ownerUserID uuid.UUID) ([]models.Share, error) {
	return q.listShares(ctx, `
		SELECT`+shareColumns+`FROM shares
		WHERE owner_user_id = $1 AND revoked_at IS NULL
		ORDER BY created_at DESC
	`, ownerUserID)
}

// ListSharesForRecipient returns the active shares addressed to the given
// (lowercased) email, newest first.
func (q *Queries) ListSharesForRecipient(ctx context.Context, email string) ([]models.Share, error) {
	return q.listShares(ctx, `
		SELECT`+shareColumns+`FROM shares
		WHERE recipient_email = $1 AND revoked_at IS NULL
		ORDER BY created_at DESC
	`, email)
}

func (q *Queries) listShares(ctx context.Context, query string, arg any) ([]models.Share, error) {
	rows, err := q.db.QueryContext(ctx, query, arg)
	if err != nil {
		return nil, fmt.Errorf("listShares: %w", err)
	}
	defer rows.Close()

	shares := make([]models.Share, 0)
	for rows.Next() {
		s, err := scanShareRow(rows.Scan)
		if err != nil {
			return nil, fmt.Errorf("listShares scan: %w", err)
		}
		shares = append(shares, *s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("listShares: %w", err)
	}
	return shares, nil
}

// RevokeShare soft-deletes an active share owned by ownerUserID.
// Returns sql.ErrNoRows when the share does not exist, belongs to someone else,
// or is already revoked.
func (q *Queries) RevokeShare(ctx context.Context, id, ownerUserID uuid.UUID) error {
	res, err := q.db.ExecContext(ctx, `
		UPDATE shares SET revoked_at = NOW()
		WHERE id = $1 AND owner_user_id = $2 AND revoked_at IS NULL
	`, id, ownerUserID)
	if err != nil {
		return fmt.Errorf("RevokeShare: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("RevokeShare: rows affected: %w", err)
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}
