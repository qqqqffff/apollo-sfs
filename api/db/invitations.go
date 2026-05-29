package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

func scanInvitation(row *sql.Row) (*models.Invitation, error) {
	var inv models.Invitation
	var acceptedAt, revokedAt sql.NullTime
	err := row.Scan(
		&inv.ID, &inv.InvitedByUserID, &inv.Email, &inv.Token,
		&inv.TokenExpiresAt, &acceptedAt, &revokedAt, &inv.CreatedAt,
		&inv.InitialQuotaBytes, &inv.GrantAdmin,
	)
	if err != nil {
		return nil, err
	}
	if acceptedAt.Valid {
		inv.AcceptedAt = &acceptedAt.Time
	}
	if revokedAt.Valid {
		inv.RevokedAt = &revokedAt.Time
	}
	return &inv, nil
}

func scanInvitationRow(rows *sql.Rows) (*models.Invitation, error) {
	var inv models.Invitation
	var acceptedAt, revokedAt sql.NullTime
	err := rows.Scan(
		&inv.ID, &inv.InvitedByUserID, &inv.Email, &inv.Token,
		&inv.TokenExpiresAt, &acceptedAt, &revokedAt, &inv.CreatedAt,
		&inv.InitialQuotaBytes, &inv.GrantAdmin,
	)
	if err != nil {
		return nil, err
	}
	if acceptedAt.Valid {
		inv.AcceptedAt = &acceptedAt.Time
	}
	if revokedAt.Valid {
		inv.RevokedAt = &revokedAt.Time
	}
	return &inv, nil
}

// CreateInvitation inserts a new invitation row.
func (q *Queries) CreateInvitation(ctx context.Context, inv *models.Invitation) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO invitations (
			id, invited_by_user_id, email, token, token_expires_at,
			initial_quota_bytes, grant_admin, created_at
		) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())
	`, inv.InvitedByUserID, inv.Email, inv.Token, inv.TokenExpiresAt, inv.InitialQuotaBytes, inv.GrantAdmin)
	if err != nil {
		return fmt.Errorf("CreateInvitation: %w", err)
	}
	return nil
}

// GetInvitationByID returns an invitation by its UUID regardless of status.
// Returns sql.ErrNoRows if not found.
func (q *Queries) GetInvitationByID(ctx context.Context, id uuid.UUID) (*models.Invitation, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT id, invited_by_user_id, email, token,
		       token_expires_at, accepted_at, revoked_at, created_at,
		       initial_quota_bytes, grant_admin
		FROM invitations WHERE id = $1
	`, id)
	inv, err := scanInvitation(row)
	if err != nil {
		return nil, fmt.Errorf("GetInvitationByID: %w", err)
	}
	return inv, nil
}

// GetInvitationByToken returns a pending invitation matching the given token.
// Returns sql.ErrNoRows if not found or already accepted/revoked.
func (q *Queries) GetInvitationByToken(ctx context.Context, token string) (*models.Invitation, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT id, invited_by_user_id, email, token,
		       token_expires_at, accepted_at, revoked_at, created_at,
		       initial_quota_bytes, grant_admin
		FROM invitations
		WHERE token = $1
		  AND accepted_at IS NULL
		  AND revoked_at IS NULL
	`, token)
	inv, err := scanInvitation(row)
	if err != nil {
		return nil, fmt.Errorf("GetInvitationByToken: %w", err)
	}
	return inv, nil
}

// ListInvitations returns a page of invitations ordered by creation time descending.
func (q *Queries) ListInvitations(ctx context.Context, in PageInput) (*PageResult[models.Invitation], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListInvitations: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, `
		SELECT id, invited_by_user_id, email, token,
		       token_expires_at, accepted_at, revoked_at, created_at,
		       initial_quota_bytes, grant_admin
		FROM invitations
		ORDER BY created_at DESC
		LIMIT $1 OFFSET $2
	`, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("ListInvitations: %w", err)
	}
	defer rows.Close()

	var invs []models.Invitation
	for rows.Next() {
		inv, err := scanInvitationRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListInvitations scan: %w", err)
		}
		invs = append(invs, *inv)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListInvitations: %w", err)
	}
	return &PageResult[models.Invitation]{
		Items:     invs,
		NextToken: offsetNextToken(len(invs), limit, offset),
	}, nil
}

// RefreshInvitationToken replaces the token and expiry for a pending (not
// accepted or revoked) invitation. Used by Resend to issue a fresh link.
func (q *Queries) RefreshInvitationToken(ctx context.Context, id uuid.UUID, newToken string, expiresAt time.Time) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE invitations
		   SET token = $2, token_expires_at = $3
		 WHERE id = $1
		   AND accepted_at IS NULL
		   AND revoked_at IS NULL
	`, id, newToken, expiresAt)
	if err != nil {
		return fmt.Errorf("RefreshInvitationToken %s: %w", id, err)
	}
	return nil
}

// RevokeInvitation sets revoked_at to NOW() for a pending invitation.
func (q *Queries) RevokeInvitation(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE invitations SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`,
		id,
	)
	if err != nil {
		return fmt.Errorf("RevokeInvitation %s: %w", id, err)
	}
	return nil
}

// AcceptInvitation sets accepted_at to NOW() for the invitation matching token.
func (q *Queries) AcceptInvitation(ctx context.Context, token string) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE invitations SET accepted_at = NOW() WHERE token = $1 AND accepted_at IS NULL`,
		token,
	)
	if err != nil {
		return fmt.Errorf("AcceptInvitation: %w", err)
	}
	return nil
}
