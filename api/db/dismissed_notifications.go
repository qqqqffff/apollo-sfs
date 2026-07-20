package db

import (
	"context"
	"fmt"

	"github.com/lib/pq"
)

// ListDismissedNotificationIDs returns the set of notification-bell item IDs
// the user has dismissed, for filtering out of the freshly-derived item list
// in Handler.Notifications.
func (q *Queries) ListDismissedNotificationIDs(ctx context.Context, username string) (map[string]bool, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT notification_id FROM dismissed_notifications WHERE username = $1
	`, username)
	if err != nil {
		return nil, fmt.Errorf("ListDismissedNotificationIDs: %w", err)
	}
	defer rows.Close()

	dismissed := make(map[string]bool)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("ListDismissedNotificationIDs scan: %w", err)
		}
		dismissed[id] = true
	}
	return dismissed, rows.Err()
}

// DismissNotifications records the given notification-bell item IDs as
// dismissed for the user, so they're filtered out of future
// Handler.Notifications responses. Re-dismissing an already-dismissed ID is a
// no-op.
func (q *Queries) DismissNotifications(ctx context.Context, username string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO dismissed_notifications (username, notification_id)
		SELECT $1, unnest($2::text[])
		ON CONFLICT (username, notification_id) DO NOTHING
	`, username, pq.Array(ids))
	if err != nil {
		return fmt.Errorf("DismissNotifications: %w", err)
	}
	return nil
}
