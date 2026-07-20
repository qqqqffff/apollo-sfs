package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// CreateFeedback inserts a new feedback submission and returns it.
func (q *Queries) CreateFeedback(ctx context.Context, userID uuid.UUID, username, category, message string) (*models.Feedback, error) {
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO feedback (user_id, username, category, message)
		VALUES ($1, $2, $3, $4)
		RETURNING id, user_id, username, category, message, status, created_at, updated_at
	`, userID, username, category, message)
	return scanFeedback(row)
}

// ListFeedback returns a page of feedback submissions, newest first.
// status filters to a single status; an empty string returns all statuses.
func (q *Queries) ListFeedback(ctx context.Context, status string, in PageInput) (*PageResult[models.Feedback], error) {
	limit := clampLimit(in.Limit)
	before, err := decodeTimeCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListFeedback: %w", err)
	}

	cols := `id, user_id, username, category, message, status, created_at, updated_at`

	var rows *sql.Rows
	if status == "" {
		if before.IsZero() {
			rows, err = q.db.QueryContext(ctx, `
				SELECT `+cols+`
				FROM   feedback
				ORDER  BY created_at DESC
				LIMIT  $1
			`, limit)
		} else {
			rows, err = q.db.QueryContext(ctx, `
				SELECT `+cols+`
				FROM   feedback
				WHERE  created_at < $2
				ORDER  BY created_at DESC
				LIMIT  $1
			`, limit, before)
		}
	} else {
		if before.IsZero() {
			rows, err = q.db.QueryContext(ctx, `
				SELECT `+cols+`
				FROM   feedback
				WHERE  status = $2
				ORDER  BY created_at DESC
				LIMIT  $1
			`, limit, status)
		} else {
			rows, err = q.db.QueryContext(ctx, `
				SELECT `+cols+`
				FROM   feedback
				WHERE  status = $2
				  AND  created_at < $3
				ORDER  BY created_at DESC
				LIMIT  $1
			`, limit, status, before)
		}
	}
	if err != nil {
		return nil, fmt.Errorf("ListFeedback: %w", err)
	}
	defer rows.Close()

	items := make([]models.Feedback, 0)
	for rows.Next() {
		f, err := scanFeedbackRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListFeedback scan: %w", err)
		}
		items = append(items, *f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListFeedback: %w", err)
	}

	var nextToken string
	if len(items) == limit {
		nextToken = encodeTimeCursor(items[len(items)-1].CreatedAt)
	}
	return &PageResult[models.Feedback]{Items: items, NextToken: nextToken}, nil
}

// UpdateFeedbackStatus sets the status of a feedback submission and returns
// the updated row. Returns sql.ErrNoRows if no submission has that id.
func (q *Queries) UpdateFeedbackStatus(ctx context.Context, id uuid.UUID, status string) (*models.Feedback, error) {
	row := q.db.QueryRowContext(ctx, `
		UPDATE feedback
		SET    status = $2, updated_at = NOW()
		WHERE  id = $1
		RETURNING id, user_id, username, category, message, status, created_at, updated_at
	`, id, status)
	return scanFeedback(row)
}

// ── Scan helpers ──────────────────────────────────────────────────────────────

func scanFeedback(row *sql.Row) (*models.Feedback, error) {
	var f models.Feedback
	if err := row.Scan(
		&f.ID, &f.UserID, &f.Username, &f.Category, &f.Message, &f.Status, &f.CreatedAt, &f.UpdatedAt,
	); err != nil {
		return nil, err
	}
	return &f, nil
}

func scanFeedbackRow(rows *sql.Rows) (*models.Feedback, error) {
	var f models.Feedback
	if err := rows.Scan(
		&f.ID, &f.UserID, &f.Username, &f.Category, &f.Message, &f.Status, &f.CreatedAt, &f.UpdatedAt,
	); err != nil {
		return nil, err
	}
	return &f, nil
}
