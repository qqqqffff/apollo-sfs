package db

import (
	"context"
	"fmt"
	"time"

	"apollo-sfs.com/api/models"
)

// InsertGoogleBackupRun records a completed Google Drive/Photos backup run.
// Runs with Notify = true surface in the notification bell until dismissed
// or aged out — see InsertEmailBackupRun for the email-backup equivalent.
func (q *Queries) InsertGoogleBackupRun(ctx context.Context, r *models.GoogleBackupRun) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO google_backup_runs (
			id, username, user_id, uploaded, duplicates, errors, notify, completed_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`, r.ID, r.Username, r.UserID, r.Uploaded, r.Duplicates, r.Errors, r.Notify, r.CompletedAt)
	if err != nil {
		return fmt.Errorf("InsertGoogleBackupRun: %w", err)
	}
	return nil
}

// ListRecentGoogleBackupRunsForUser returns the user's notify-enabled backup
// runs completed since the given time, newest first. Backs the notification
// bell's "google backup completed" category.
func (q *Queries) ListRecentGoogleBackupRunsForUser(ctx context.Context, username string, since time.Time) ([]models.GoogleBackupRun, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT id, username, user_id, uploaded, duplicates, errors, notify, completed_at
		FROM google_backup_runs
		WHERE username = $1 AND notify = TRUE AND completed_at >= $2
		ORDER BY completed_at DESC
	`, username, since)
	if err != nil {
		return nil, fmt.Errorf("ListRecentGoogleBackupRunsForUser: %w", err)
	}
	defer rows.Close()

	var runs []models.GoogleBackupRun
	for rows.Next() {
		var r models.GoogleBackupRun
		if err := rows.Scan(
			&r.ID, &r.Username, &r.UserID, &r.Uploaded, &r.Duplicates, &r.Errors, &r.Notify, &r.CompletedAt,
		); err != nil {
			return nil, fmt.Errorf("ListRecentGoogleBackupRunsForUser scan: %w", err)
		}
		runs = append(runs, r)
	}
	return runs, rows.Err()
}
