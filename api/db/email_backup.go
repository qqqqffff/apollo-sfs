package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

const emailBackupMessageCols = `id, user_id, folder_id, file_id, provider, provider_message_id,
	from_addr, to_addr, subject, snippet, has_attachments, starred, read, received_at, created_at`

func scanEmailBackupMessage(rows *sql.Rows) (*models.EmailBackupMessage, error) {
	var m models.EmailBackupMessage
	err := rows.Scan(
		&m.ID, &m.UserID, &m.FolderID, &m.FileID, &m.Provider, &m.ProviderMessageID,
		&m.FromAddr, &m.ToAddr, &m.Subject, &m.Snippet, &m.HasAttachments,
		&m.Starred, &m.Read, &m.ReceivedAt, &m.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// InsertEmailBackupMessage persists an index row for a backed-up message. The
// full message is expected to already be uploaded as the encrypted file
// referenced by m.FileID.
//
// A message already backed up into the same folder (same provider_message_id)
// makes the insert a no-op; inserted reports whether a row was actually
// written so the caller can clean up the just-uploaded file on a duplicate.
// email_backup_messages is RLS-protected — call on a ForUser-derived Queries.
func (q *Queries) InsertEmailBackupMessage(ctx context.Context, m *models.EmailBackupMessage) (inserted bool, err error) {
	res, err := q.db.ExecContext(ctx, `
		INSERT INTO email_backup_messages (
			id, user_id, folder_id, file_id, provider, provider_message_id,
			from_addr, to_addr, subject, snippet, has_attachments, starred, read, received_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, FALSE, $13)
		ON CONFLICT (folder_id, provider_message_id) DO NOTHING
	`, m.ID, m.UserID, m.FolderID, m.FileID, m.Provider, m.ProviderMessageID,
		m.FromAddr, m.ToAddr, m.Subject, m.Snippet, m.HasAttachments, m.Starred, m.ReceivedAt)
	if err != nil {
		return false, fmt.Errorf("InsertEmailBackupMessage: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("InsertEmailBackupMessage rows affected: %w", err)
	}
	return n > 0, nil
}

// ExistsEmailBackupMessage reports whether providerMessageID is already backed
// up into folderID, letting the service skip the blob upload entirely on a
// duplicate. Call on a ForUser-derived Queries.
func (q *Queries) ExistsEmailBackupMessage(ctx context.Context, folderID uuid.UUID, providerMessageID string) (bool, error) {
	var exists bool
	err := q.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM email_backup_messages
			WHERE folder_id = $1 AND provider_message_id = $2
		)
	`, folderID, providerMessageID).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("ExistsEmailBackupMessage: %w", err)
	}
	return exists, nil
}

// ListEmailBackupMessages returns a page of index rows for one backup folder,
// newest first. A non-empty fromAddr scopes the page to that sender (the
// viewer's sender sidebar). Call on a ForUser-derived Queries.
func (q *Queries) ListEmailBackupMessages(ctx context.Context, folderID uuid.UUID, fromAddr string, in PageInput) (*PageResult[models.EmailBackupMessage], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListEmailBackupMessages: %w", err)
	}

	var rows *sql.Rows
	if fromAddr == "" {
		rows, err = q.db.QueryContext(ctx, `
			SELECT `+emailBackupMessageCols+`
			FROM email_backup_messages
			WHERE folder_id = $1
			ORDER BY received_at DESC
			LIMIT $2 OFFSET $3
		`, folderID, limit, offset)
	} else {
		rows, err = q.db.QueryContext(ctx, `
			SELECT `+emailBackupMessageCols+`
			FROM email_backup_messages
			WHERE folder_id = $1 AND from_addr = $4
			ORDER BY received_at DESC
			LIMIT $2 OFFSET $3
		`, folderID, limit, offset, fromAddr)
	}
	if err != nil {
		return nil, fmt.Errorf("ListEmailBackupMessages: %w", err)
	}
	defer rows.Close()

	var messages []models.EmailBackupMessage
	for rows.Next() {
		m, err := scanEmailBackupMessage(rows)
		if err != nil {
			return nil, fmt.Errorf("ListEmailBackupMessages scan: %w", err)
		}
		messages = append(messages, *m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListEmailBackupMessages: %w", err)
	}
	return &PageResult[models.EmailBackupMessage]{
		Items:     messages,
		NextToken: offsetNextToken(len(messages), limit, offset),
	}, nil
}

// GetEmailBackupMessage returns a single index row by id, or sql.ErrNoRows.
// Call on a ForUser-derived Queries.
func (q *Queries) GetEmailBackupMessage(ctx context.Context, id uuid.UUID) (*models.EmailBackupMessage, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+emailBackupMessageCols+`
		FROM email_backup_messages
		WHERE id = $1
	`, id)
	if err != nil {
		return nil, fmt.Errorf("GetEmailBackupMessage: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("GetEmailBackupMessage: %w", err)
		}
		return nil, sql.ErrNoRows
	}
	m, err := scanEmailBackupMessage(rows)
	if err != nil {
		return nil, fmt.Errorf("GetEmailBackupMessage scan: %w", err)
	}
	return m, nil
}

// MarkEmailBackupMessageRead flags a message as read. Idempotent.
// Call on a ForUser-derived Queries.
func (q *Queries) MarkEmailBackupMessageRead(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE email_backup_messages SET read = TRUE WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("MarkEmailBackupMessageRead %s: %w", id, err)
	}
	return nil
}

// DeleteEmailBackupMessage removes the index row. The backing file is deleted
// separately via the file service (the FK also cascades if the file goes
// first). Call on a ForUser-derived Queries.
func (q *Queries) DeleteEmailBackupMessage(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx,
		`DELETE FROM email_backup_messages WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("DeleteEmailBackupMessage %s: %w", id, err)
	}
	return nil
}

// ListEmailBackupSenders returns one summary per distinct from_addr in the
// folder with total and unread counts, most mail first. Backs the viewer's
// sender sidebar (the user-side analogue of ListEmailWorkers).
// Call on a ForUser-derived Queries.
func (q *Queries) ListEmailBackupSenders(ctx context.Context, folderID uuid.UUID) ([]models.EmailBackupSenderSummary, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT from_addr,
		       COUNT(*)                             AS total_count,
		       COUNT(*) FILTER (WHERE read = FALSE) AS unread_count
		FROM email_backup_messages
		WHERE folder_id = $1
		GROUP BY from_addr
		ORDER BY total_count DESC, from_addr ASC
	`, folderID)
	if err != nil {
		return nil, fmt.Errorf("ListEmailBackupSenders: %w", err)
	}
	defer rows.Close()

	var senders []models.EmailBackupSenderSummary
	for rows.Next() {
		var s models.EmailBackupSenderSummary
		if err := rows.Scan(&s.FromAddr, &s.TotalCount, &s.UnreadCount); err != nil {
			return nil, fmt.Errorf("ListEmailBackupSenders scan: %w", err)
		}
		senders = append(senders, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListEmailBackupSenders: %w", err)
	}
	return senders, nil
}

// InsertEmailBackupRun records a completed backup run. Runs with Notify = true
// surface in the notification bell until dismissed or aged out.
func (q *Queries) InsertEmailBackupRun(ctx context.Context, r *models.EmailBackupRun) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO email_backup_runs (
			id, username, user_id, folder_id, email_address, provider,
			uploaded, duplicates, errors, notify, completed_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
	`, r.ID, r.Username, r.UserID, r.FolderID, r.EmailAddress, r.Provider,
		r.Uploaded, r.Duplicates, r.Errors, r.Notify, r.CompletedAt)
	if err != nil {
		return fmt.Errorf("InsertEmailBackupRun: %w", err)
	}
	return nil
}

// ListRecentEmailBackupRunsForUser returns the user's notify-enabled backup
// runs completed since the given time, newest first. Backs the notification
// bell's "email backup completed" category.
func (q *Queries) ListRecentEmailBackupRunsForUser(ctx context.Context, username string, since time.Time) ([]models.EmailBackupRun, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT id, username, user_id, folder_id, email_address, provider,
		       uploaded, duplicates, errors, notify, completed_at
		FROM email_backup_runs
		WHERE username = $1 AND notify = TRUE AND completed_at >= $2
		ORDER BY completed_at DESC
	`, username, since)
	if err != nil {
		return nil, fmt.Errorf("ListRecentEmailBackupRunsForUser: %w", err)
	}
	defer rows.Close()

	var runs []models.EmailBackupRun
	for rows.Next() {
		var r models.EmailBackupRun
		var folderID uuid.NullUUID
		if err := rows.Scan(
			&r.ID, &r.Username, &r.UserID, &folderID, &r.EmailAddress, &r.Provider,
			&r.Uploaded, &r.Duplicates, &r.Errors, &r.Notify, &r.CompletedAt,
		); err != nil {
			return nil, fmt.Errorf("ListRecentEmailBackupRunsForUser scan: %w", err)
		}
		if folderID.Valid {
			r.FolderID = &folderID.UUID
		}
		runs = append(runs, r)
	}
	return runs, rows.Err()
}

// GetLastGoogleBackupSync returns when the user's most recent Google backup
// file (Drive or Photos source) was uploaded, or nil if they have never run
// one. files is RLS-protected, so this opens its own ForUser transaction.
func (q *Queries) GetLastGoogleBackupSync(ctx context.Context, userID uuid.UUID) (*time.Time, error) {
	qu, tx, err := q.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("GetLastGoogleBackupSync: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var last sql.NullTime
	err = qu.db.QueryRowContext(ctx, `
		SELECT MAX(created_at) FROM files
		WHERE user_id = $1 AND source IN ('google_drive', 'google_photos')
	`, userID).Scan(&last)
	if err != nil {
		return nil, fmt.Errorf("GetLastGoogleBackupSync: %w", err)
	}
	if !last.Valid {
		return nil, nil
	}
	t := last.Time
	return &t, nil
}

// GetLastEmailBackupSync returns when the user's most recent email backup run
// completed, or nil if they have never run one.
func (q *Queries) GetLastEmailBackupSync(ctx context.Context, username string) (*time.Time, error) {
	var last sql.NullTime
	err := q.db.QueryRowContext(ctx, `
		SELECT MAX(completed_at) FROM email_backup_runs WHERE username = $1
	`, username).Scan(&last)
	if err != nil {
		return nil, fmt.Errorf("GetLastEmailBackupSync: %w", err)
	}
	if !last.Valid {
		return nil, nil
	}
	t := last.Time
	return &t, nil
}

// GetEmailBackupFolder returns the user's root-level email-backup folder whose
// name matches emailAddress (case-insensitive), or sql.ErrNoRows. folders is
// RLS-protected — call on a ForUser-derived Queries.
func (q *Queries) GetEmailBackupFolder(ctx context.Context, userID uuid.UUID, emailAddress string) (*models.Folder, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT id, user_id, parent_id, drive_id, name, kind, created_at, updated_at
		FROM folders
		WHERE user_id = $1 AND parent_id IS NULL AND kind = $2 AND LOWER(name) = LOWER($3)
	`, userID, models.FolderKindEmail, emailAddress)
	if err != nil {
		return nil, fmt.Errorf("GetEmailBackupFolder: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("GetEmailBackupFolder: %w", err)
		}
		return nil, sql.ErrNoRows
	}
	var f models.Folder
	if err := rows.Scan(&f.ID, &f.UserID, &f.ParentID, &f.DriveID, &f.Name, &f.Kind, &f.CreatedAt, &f.UpdatedAt); err != nil {
		return nil, fmt.Errorf("GetEmailBackupFolder scan: %w", err)
	}
	return &f, nil
}
