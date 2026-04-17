package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

func scanEmailQueue(rows *sql.Rows) (*models.EmailQueue, error) {
	var e models.EmailQueue
	var lastError sql.NullString
	var sentAt sql.NullTime
	err := rows.Scan(
		&e.ID, &e.ToAddress, &e.Subject, &e.TemplateName,
		&e.TemplateData, &e.Status, &e.Attempts, &lastError, &e.CreatedAt, &sentAt,
	)
	if err != nil {
		return nil, err
	}
	if lastError.Valid {
		e.LastError = &lastError.String
	}
	if sentAt.Valid {
		e.SentAt = &sentAt.Time
	}
	return &e, nil
}

// EnqueueEmail inserts a new email job with status "pending" and zero attempts.
func (q *Queries) EnqueueEmail(ctx context.Context, e *models.EmailQueue) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO email_queue (
			id, to_address, subject, template_name,
			template_data, status, attempts, created_at
		) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 0, NOW())
	`, e.ToAddress, e.Subject, e.TemplateName, e.TemplateData, models.EmailStatusPending)
	if err != nil {
		return fmt.Errorf("EnqueueEmail: %w", err)
	}
	return nil
}

// GetPendingEmails returns a page of emails with status "pending", oldest first.
func (q *Queries) GetPendingEmails(ctx context.Context, in PageInput) (*PageResult[models.EmailQueue], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("GetPendingEmails: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, `
		SELECT id, to_address, subject, template_name,
		       template_data, status, attempts, last_error, created_at, sent_at
		FROM email_queue
		WHERE status = $1
		ORDER BY created_at ASC
		LIMIT $2 OFFSET $3
	`, models.EmailStatusPending, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("GetPendingEmails: %w", err)
	}
	defer rows.Close()

	var emails []models.EmailQueue
	for rows.Next() {
		e, err := scanEmailQueue(rows)
		if err != nil {
			return nil, fmt.Errorf("GetPendingEmails scan: %w", err)
		}
		emails = append(emails, *e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("GetPendingEmails: %w", err)
	}
	return &PageResult[models.EmailQueue]{
		Items:     emails,
		NextToken: offsetNextToken(len(emails), limit, offset),
	}, nil
}

// MarkEmailSent sets status to "sent" and records the delivery timestamp.
func (q *Queries) MarkEmailSent(ctx context.Context, id uuid.UUID, sentAt time.Time) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE email_queue SET status = $2, sent_at = $3 WHERE id = $1`,
		id, models.EmailStatusSent, sentAt,
	)
	if err != nil {
		return fmt.Errorf("MarkEmailSent %s: %w", id, err)
	}
	return nil
}

// MarkEmailFailed sets status to "failed" and records the last SMTP error.
func (q *Queries) MarkEmailFailed(ctx context.Context, id uuid.UUID, lastError string) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE email_queue SET status = $2, last_error = $3 WHERE id = $1`,
		id, models.EmailStatusFailed, lastError,
	)
	if err != nil {
		return fmt.Errorf("MarkEmailFailed %s: %w", id, err)
	}
	return nil
}

// IncrementEmailAttempts increments the attempt counter for a queued email.
// Call this before each send attempt.
func (q *Queries) IncrementEmailAttempts(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE email_queue SET attempts = attempts + 1 WHERE id = $1`,
		id,
	)
	if err != nil {
		return fmt.Errorf("IncrementEmailAttempts %s: %w", id, err)
	}
	return nil
}
