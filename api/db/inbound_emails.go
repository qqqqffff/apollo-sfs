package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

func scanInboundEmail(rows *sql.Rows) (*models.InboundEmail, error) {
	var e models.InboundEmail
	var messageID sql.NullString
	err := rows.Scan(
		&e.ID, &e.WorkerName, &messageID, &e.FromAddr, &e.ToAddr,
		&e.Subject, &e.FilePath, &e.HasAttachments, &e.Read, &e.ReceivedAt,
	)
	if err != nil {
		return nil, err
	}
	if messageID.Valid {
		e.MessageID = &messageID.String
	}
	return &e, nil
}

// InsertInboundEmail persists an index row for a received email. The full
// message body is expected to already be written to e.FilePath on disk.
//
// When e.MessageID is set and a row with the same message_id already exists the
// insert is a no-op (SendGrid delivers at-least-once and retries on non-2xx).
// inserted reports whether a new row was actually written so the caller can
// clean up the just-written file on a duplicate.
func (q *Queries) InsertInboundEmail(ctx context.Context, e *models.InboundEmail) (inserted bool, err error) {
	var messageID any
	if e.MessageID != nil {
		messageID = *e.MessageID
	}
	res, err := q.db.ExecContext(ctx, `
		INSERT INTO inbound_emails (
			id, worker_name, message_id, from_addr, to_addr,
			subject, file_path, has_attachments, read, received_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, $9)
		ON CONFLICT (message_id) DO NOTHING
	`, e.ID, e.WorkerName, messageID, e.FromAddr, e.ToAddr,
		e.Subject, e.FilePath, e.HasAttachments, e.ReceivedAt)
	if err != nil {
		return false, fmt.Errorf("InsertInboundEmail: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("InsertInboundEmail rows affected: %w", err)
	}
	return n > 0, nil
}

// ListInboundEmails returns a page of index rows ordered by received_at DESC.
// When workerName is non-empty results are scoped to that worker's mailbox;
// an empty workerName lists every worker's mail interleaved by time.
func (q *Queries) ListInboundEmails(ctx context.Context, workerName string, in PageInput) (*PageResult[models.InboundEmail], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListInboundEmails: %w", err)
	}

	const cols = `id, worker_name, message_id, from_addr, to_addr,
	              subject, file_path, has_attachments, read, received_at`

	var rows *sql.Rows
	if workerName == "" {
		rows, err = q.db.QueryContext(ctx, `
			SELECT `+cols+`
			FROM inbound_emails
			ORDER BY received_at DESC
			LIMIT $1 OFFSET $2
		`, limit, offset)
	} else {
		rows, err = q.db.QueryContext(ctx, `
			SELECT `+cols+`
			FROM inbound_emails
			WHERE worker_name = $3
			ORDER BY received_at DESC
			LIMIT $1 OFFSET $2
		`, limit, offset, workerName)
	}
	if err != nil {
		return nil, fmt.Errorf("ListInboundEmails: %w", err)
	}
	defer rows.Close()

	var emails []models.InboundEmail
	for rows.Next() {
		e, err := scanInboundEmail(rows)
		if err != nil {
			return nil, fmt.Errorf("ListInboundEmails scan: %w", err)
		}
		emails = append(emails, *e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListInboundEmails: %w", err)
	}
	return &PageResult[models.InboundEmail]{
		Items:     emails,
		NextToken: offsetNextToken(len(emails), limit, offset),
	}, nil
}

// GetInboundEmail returns a single index row by id, or sql.ErrNoRows.
func (q *Queries) GetInboundEmail(ctx context.Context, id uuid.UUID) (*models.InboundEmail, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT id, worker_name, message_id, from_addr, to_addr,
		       subject, file_path, has_attachments, read, received_at
		FROM inbound_emails
		WHERE id = $1
	`, id)
	if err != nil {
		return nil, fmt.Errorf("GetInboundEmail: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("GetInboundEmail: %w", err)
		}
		return nil, sql.ErrNoRows
	}
	e, err := scanInboundEmail(rows)
	if err != nil {
		return nil, fmt.Errorf("GetInboundEmail scan: %w", err)
	}
	return e, nil
}

// MarkInboundEmailRead flags a message as read. It is idempotent.
func (q *Queries) MarkInboundEmailRead(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE inbound_emails SET read = TRUE WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("MarkInboundEmailRead %s: %w", id, err)
	}
	return nil
}

// DeleteInboundEmail removes the index row. The caller is responsible for
// removing the backing file from disk.
func (q *Queries) DeleteInboundEmail(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx,
		`DELETE FROM inbound_emails WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("DeleteInboundEmail %s: %w", id, err)
	}
	return nil
}

// ListEmailWorkers returns one summary per distinct worker_name with total and
// unread counts, ordered alphabetically.
func (q *Queries) ListEmailWorkers(ctx context.Context) ([]models.WorkerSummary, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT worker_name,
		       COUNT(*)                                  AS total_count,
		       COUNT(*) FILTER (WHERE read = FALSE)      AS unread_count
		FROM inbound_emails
		GROUP BY worker_name
		ORDER BY worker_name ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("ListEmailWorkers: %w", err)
	}
	defer rows.Close()

	var workers []models.WorkerSummary
	for rows.Next() {
		var w models.WorkerSummary
		if err := rows.Scan(&w.WorkerName, &w.TotalCount, &w.UnreadCount); err != nil {
			return nil, fmt.Errorf("ListEmailWorkers scan: %w", err)
		}
		workers = append(workers, w)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListEmailWorkers: %w", err)
	}
	return workers, nil
}
