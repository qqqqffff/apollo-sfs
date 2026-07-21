package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// file_server_links has no RLS (like shares): the DAV endpoint resolves a
// link by token before any user context exists. Every query filters
// explicitly by username or token.

const fileServerLinkColumns = `
	l.id, l.token, l.username, l.user_id, l.server_id, l.drive_id,
	l.enhanced_security, l.created_at, l.last_used_at, s.name, d.drive_type`

func scanFileServerLink(scan func(dest ...any) error) (*models.FileServerLink, error) {
	var l models.FileServerLink
	var lastUsed sql.NullTime
	if err := scan(
		&l.ID, &l.Token, &l.Username, &l.UserID, &l.ServerID, &l.DriveID,
		&l.EnhancedSecurity, &l.CreatedAt, &lastUsed, &l.ServerName, &l.DriveType,
	); err != nil {
		return nil, err
	}
	if lastUsed.Valid {
		l.LastUsedAt = &lastUsed.Time
	}
	return &l, nil
}

// CreateFileServerLink inserts a new mount link. Returns sql.ErrNoRows-style
// unique violations to the caller unchanged so the service can map them.
func (q *Queries) CreateFileServerLink(ctx context.Context, l *models.FileServerLink) (*models.FileServerLink, error) {
	row := q.db.QueryRowContext(ctx, `
		WITH ins AS (
			INSERT INTO file_server_links (token, username, user_id, server_id, drive_id, enhanced_security)
			VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING *
		)
		SELECT `+fileServerLinkColumns+`
		FROM ins l JOIN servers s ON s.id = l.server_id JOIN drives d ON d.id = l.drive_id
	`, l.Token, l.Username, l.UserID, l.ServerID, l.DriveID, l.EnhancedSecurity)
	created, err := scanFileServerLink(row.Scan)
	if err != nil {
		return nil, fmt.Errorf("CreateFileServerLink: %w", err)
	}
	return created, nil
}

// GetFileServerLinkByToken resolves an active mount link by its URL token.
// sql.ErrNoRows when the token does not exist (deleted links vanish entirely).
func (q *Queries) GetFileServerLinkByToken(ctx context.Context, token string) (*models.FileServerLink, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT `+fileServerLinkColumns+`
		FROM file_server_links l JOIN servers s ON s.id = l.server_id JOIN drives d ON d.id = l.drive_id
		WHERE l.token = $1
	`, token)
	l, err := scanFileServerLink(row.Scan)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, err
		}
		return nil, fmt.Errorf("GetFileServerLinkByToken: %w", err)
	}
	return l, nil
}

// GetFileServerLinkByDrive returns the user's link for a drive, if any.
func (q *Queries) GetFileServerLinkByDrive(ctx context.Context, username string, driveID uuid.UUID) (*models.FileServerLink, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT `+fileServerLinkColumns+`
		FROM file_server_links l JOIN servers s ON s.id = l.server_id JOIN drives d ON d.id = l.drive_id
		WHERE l.username = $1 AND l.drive_id = $2
	`, username, driveID)
	l, err := scanFileServerLink(row.Scan)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, err
		}
		return nil, fmt.Errorf("GetFileServerLinkByDrive: %w", err)
	}
	return l, nil
}

// ListFileServerLinks returns all of a user's mount links, newest first.
func (q *Queries) ListFileServerLinks(ctx context.Context, username string) ([]models.FileServerLink, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+fileServerLinkColumns+`
		FROM file_server_links l JOIN servers s ON s.id = l.server_id JOIN drives d ON d.id = l.drive_id
		WHERE l.username = $1
		ORDER BY l.created_at DESC
	`, username)
	if err != nil {
		return nil, fmt.Errorf("ListFileServerLinks: %w", err)
	}
	defer rows.Close()
	var out []models.FileServerLink
	for rows.Next() {
		l, err := scanFileServerLink(rows.Scan)
		if err != nil {
			return nil, fmt.Errorf("ListFileServerLinks scan: %w", err)
		}
		out = append(out, *l)
	}
	return out, rows.Err()
}

// DeleteFileServerLink destroys one of the user's links. Locations cascade.
// Returns the number of rows deleted (0 = not found / not owned).
func (q *Queries) DeleteFileServerLink(ctx context.Context, username string, id uuid.UUID) (int64, error) {
	res, err := q.db.ExecContext(ctx, `
		DELETE FROM file_server_links WHERE username = $1 AND id = $2
	`, username, id)
	if err != nil {
		return 0, fmt.Errorf("DeleteFileServerLink: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// DeleteAllFileServerLinks destroys every link a user owns. Called when
// premium membership lapses (JWT role sync or payment refund/dispute).
func (q *Queries) DeleteAllFileServerLinks(ctx context.Context, username string) (int64, error) {
	res, err := q.db.ExecContext(ctx, `
		DELETE FROM file_server_links WHERE username = $1
	`, username)
	if err != nil {
		return 0, fmt.Errorf("DeleteAllFileServerLinks: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// SetFileServerLinkEnhancedSecurity flips the enhanced-security toggle on an
// existing link.
func (q *Queries) SetFileServerLinkEnhancedSecurity(ctx context.Context, username string, id uuid.UUID, enabled bool) (int64, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE file_server_links SET enhanced_security = $3 WHERE username = $1 AND id = $2
	`, username, id, enabled)
	if err != nil {
		return 0, fmt.Errorf("SetFileServerLinkEnhancedSecurity: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// TouchFileServerLink stamps last_used_at. Best-effort; called per DAV request.
func (q *Queries) TouchFileServerLink(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE file_server_links SET last_used_at = NOW() WHERE id = $1
	`, id)
	if err != nil {
		return fmt.Errorf("TouchFileServerLink: %w", err)
	}
	return nil
}

// ── Enhanced-security locations ───────────────────────────────────────────────

// GetLinkLocation returns the ledger row for (link, source IP), or
// sql.ErrNoRows when this IP has never been seen.
func (q *Queries) GetLinkLocation(ctx context.Context, linkID uuid.UUID, sourceIP string) (*models.FileServerLinkLocation, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT id, link_id, source_ip, verification_token, verification_sent_at, verified_at, created_at
		FROM file_server_link_locations
		WHERE link_id = $1 AND source_ip = $2
	`, linkID, sourceIP)
	return scanLinkLocation(row.Scan)
}

func scanLinkLocation(scan func(dest ...any) error) (*models.FileServerLinkLocation, error) {
	var loc models.FileServerLinkLocation
	var token sql.NullString
	var sentAt, verifiedAt sql.NullTime
	if err := scan(&loc.ID, &loc.LinkID, &loc.SourceIP, &token, &sentAt, &verifiedAt, &loc.CreatedAt); err != nil {
		return nil, err
	}
	if token.Valid {
		loc.VerificationToken = &token.String
	}
	if sentAt.Valid {
		loc.VerificationSentAt = &sentAt.Time
	}
	if verifiedAt.Valid {
		loc.VerifiedAt = &verifiedAt.Time
	}
	return &loc, nil
}

// UpsertPendingLinkLocation records a fresh verification token for (link, IP),
// creating the ledger row if needed. The previous verified_at is preserved so
// an expired-but-once-verified location keeps its history.
func (q *Queries) UpsertPendingLinkLocation(ctx context.Context, linkID uuid.UUID, sourceIP, token string) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO file_server_link_locations (link_id, source_ip, verification_token, verification_sent_at)
		VALUES ($1, $2, $3, NOW())
		ON CONFLICT (link_id, source_ip) DO UPDATE
		SET verification_token = EXCLUDED.verification_token,
		    verification_sent_at = NOW()
	`, linkID, sourceIP, token)
	if err != nil {
		return fmt.Errorf("UpsertPendingLinkLocation: %w", err)
	}
	return nil
}

// VerifyLinkLocation consumes a verification token: it must belong to a link
// owned by username and have been sent within maxAge. Marks the location
// verified now and clears the token. Returns the number of rows updated
// (0 = invalid, expired, or not owned by this user).
func (q *Queries) VerifyLinkLocation(ctx context.Context, username, token string, maxAge time.Duration) (int64, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE file_server_link_locations loc
		SET verified_at = NOW(), verification_token = NULL
		FROM file_server_links l
		WHERE loc.link_id = l.id
		  AND l.username = $1
		  AND loc.verification_token = $2
		  AND loc.verification_sent_at > NOW() - $3::interval
	`, username, token, fmt.Sprintf("%d seconds", int(maxAge.Seconds())))
	if err != nil {
		return 0, fmt.Errorf("VerifyLinkLocation: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// ── Server-scoped folder/file listing for the DAV tree ───────────────────────

// ListFolderChildren returns every subfolder of parentID (nil = root) for the
// user, name-ordered, unpaginated. folders has RLS: call through a ForUser
// transaction.
func (q *Queries) ListFolderChildren(ctx context.Context, userID uuid.UUID, parentID *uuid.UUID) ([]models.Folder, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT id, user_id, parent_id, drive_id, name, kind, created_at, updated_at
		FROM folders
		WHERE user_id = $1
		  AND (($2::uuid IS NULL AND parent_id IS NULL) OR parent_id = $2)
		ORDER BY name ASC
	`, userID, uuidPtrToNull(parentID))
	if err != nil {
		return nil, fmt.Errorf("ListFolderChildren: %w", err)
	}
	defer rows.Close()
	var out []models.Folder
	for rows.Next() {
		var f models.Folder
		var parent, drive uuid.NullUUID
		if err := rows.Scan(&f.ID, &f.UserID, &parent, &drive, &f.Name, &f.Kind, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, fmt.Errorf("ListFolderChildren scan: %w", err)
		}
		if parent.Valid {
			f.ParentID = &parent.UUID
		}
		if drive.Valid {
			f.DriveID = &drive.UUID
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// ListFilesByFolderOnDrive returns the user's files inside folderID (nil =
// root) that are stored on driveID, name-ordered, unpaginated. files has
// RLS: call through a ForUser transaction.
func (q *Queries) ListFilesByFolderOnDrive(ctx context.Context, userID uuid.UUID, folderID *uuid.UUID, driveID uuid.UUID) ([]models.File, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+fileColumns+`
		FROM files
		WHERE user_id = $1
		  AND (($2::uuid IS NULL AND folder_id IS NULL) OR folder_id = $2)
		  AND drive_id = $3
		ORDER BY name ASC
	`, userID, uuidPtrToNull(folderID), driveID)
	if err != nil {
		return nil, fmt.Errorf("ListFilesByFolderOnDrive: %w", err)
	}
	defer rows.Close()
	var out []models.File
	for rows.Next() {
		f, err := scanFileRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListFilesByFolderOnDrive scan: %w", err)
		}
		out = append(out, *f)
	}
	return out, rows.Err()
}

// GetUserDriveQuotaAndUsage reports userID's own per-drive quota_bytes
// allocation on driveID and their bytes stored on it — the real per-user
// figures hasRoomForUpload (routes/services/file.go) gates uploads against,
// used here so WebDAV-reported quota can never drift from actual upload
// enforcement. Returns (0, 0, nil) if the user has no allocation row on this
// drive at all (orphaned link: allocation revoked, e.g. by an admin, but the
// link row not yet cleaned up) — report an empty drive rather than erroring.
// This is a different orphan case than GetDriveAvailableBytes's ErrNoRows
// (missing drive row, not missing allocation row). drives/user_drive_allocations
// have no RLS, so this is callable outside a ForUser transaction.
func (q *Queries) GetUserDriveQuotaAndUsage(ctx context.Context, driveID uuid.UUID, username string, userID uuid.UUID) (quotaBytes, usedBytes int64, err error) {
	err = q.db.QueryRowContext(ctx, `
		SELECT uda.quota_bytes, COALESCE(SUM(f.size_bytes), 0)
		FROM user_drive_allocations uda
		LEFT JOIN files f ON f.drive_id = uda.drive_id AND f.user_id = $3
		WHERE uda.drive_id = $1 AND uda.user_id = $2
		GROUP BY uda.quota_bytes
	`, driveID, username, userID).Scan(&quotaBytes, &usedBytes)
	if err == sql.ErrNoRows {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, fmt.Errorf("GetUserDriveQuotaAndUsage: %w", err)
	}
	return quotaBytes, usedBytes, nil
}

func uuidPtrToNull(p *uuid.UUID) uuid.NullUUID {
	if p == nil {
		return uuid.NullUUID{}
	}
	return uuid.NullUUID{UUID: *p, Valid: true}
}
