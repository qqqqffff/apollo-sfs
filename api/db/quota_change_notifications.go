package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// InsertQuotaChangeNotificationParams holds the fields written to
// quota_change_notifications for a single admin storage-allocation save —
// feeds the affected user's notification bell "Breakdown" button.
type InsertQuotaChangeNotificationParams struct {
	Username  string
	ChangedBy string
	Reason    *string
	Details   json.RawMessage
}

// InsertQuotaChangeNotification writes one row. Errors are logged by the caller.
func (q *Queries) InsertQuotaChangeNotification(ctx context.Context, p InsertQuotaChangeNotificationParams) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO quota_change_notifications (username, changed_by, reason, details)
		VALUES ($1, $2, $3, $4)
	`, p.Username, p.ChangedBy, p.Reason, []byte(p.Details))
	if err != nil {
		return fmt.Errorf("InsertQuotaChangeNotification: %w", err)
	}
	return nil
}

// QuotaChangeNotification is one row of quota_change_notifications.
type QuotaChangeNotification struct {
	ID        uuid.UUID
	Username  string
	ChangedBy string
	Reason    *string
	Details   json.RawMessage
	CreatedAt time.Time
}

// ListRecentQuotaChangeNotificationsForUser returns username's storage
// allocation changes since the given time, newest first — consumed by
// gatherNotificationItems to synthesize "quota_changed" bell items. Mirrors
// ListRecentAdminCancelledSubscriptionsForUser's shape/contract.
func (q *Queries) ListRecentQuotaChangeNotificationsForUser(ctx context.Context, username string, since time.Time) ([]QuotaChangeNotification, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT id, username, changed_by, reason, details, created_at
		FROM quota_change_notifications
		WHERE username = $1 AND created_at > $2
		ORDER BY created_at DESC
	`, username, since)
	if err != nil {
		return nil, fmt.Errorf("ListRecentQuotaChangeNotificationsForUser: %w", err)
	}
	defer rows.Close()

	var out []QuotaChangeNotification
	for rows.Next() {
		var n QuotaChangeNotification
		var reason sql.NullString
		var details []byte
		if err := rows.Scan(&n.ID, &n.Username, &n.ChangedBy, &reason, &details, &n.CreatedAt); err != nil {
			return nil, fmt.Errorf("ListRecentQuotaChangeNotificationsForUser scan: %w", err)
		}
		if reason.Valid {
			n.Reason = &reason.String
		}
		n.Details = details
		out = append(out, n)
	}
	return out, rows.Err()
}
