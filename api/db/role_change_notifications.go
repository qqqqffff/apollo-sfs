package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// InsertRoleChangeNotificationParams holds the fields written to
// role_change_notifications for a single admin role assignment — feeds the
// affected user's notification bell with the admin's reason.
type InsertRoleChangeNotificationParams struct {
	Username           string
	ChangedBy          string
	PreviousRole       string
	NewRole            string
	Reason             string
	PremiumExpiresAt   *time.Time
	BlockFuturePremium bool
}

// InsertRoleChangeNotification writes one row. Errors are logged by the caller.
func (q *Queries) InsertRoleChangeNotification(ctx context.Context, p InsertRoleChangeNotificationParams) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO role_change_notifications
			(username, changed_by, previous_role, new_role, reason, premium_expires_at, block_future_premium)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, p.Username, p.ChangedBy, p.PreviousRole, p.NewRole, p.Reason, p.PremiumExpiresAt, p.BlockFuturePremium)
	if err != nil {
		return fmt.Errorf("InsertRoleChangeNotification: %w", err)
	}
	return nil
}

// RoleChangeNotification is one row of role_change_notifications.
type RoleChangeNotification struct {
	ID                 uuid.UUID
	Username           string
	ChangedBy          string
	PreviousRole       string
	NewRole            string
	Reason             string
	PremiumExpiresAt   *time.Time
	BlockFuturePremium bool
	CreatedAt          time.Time
}

// ListRecentRoleChangeNotificationsForUser returns username's role changes
// since the given time, newest first — consumed by gatherNotificationItems to
// synthesize "role_changed" bell items. Mirrors
// ListRecentQuotaChangeNotificationsForUser's shape/contract.
func (q *Queries) ListRecentRoleChangeNotificationsForUser(ctx context.Context, username string, since time.Time) ([]RoleChangeNotification, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT id, username, changed_by, previous_role, new_role, reason,
		       premium_expires_at, block_future_premium, created_at
		FROM role_change_notifications
		WHERE username = $1 AND created_at > $2
		ORDER BY created_at DESC
	`, username, since)
	if err != nil {
		return nil, fmt.Errorf("ListRecentRoleChangeNotificationsForUser: %w", err)
	}
	defer rows.Close()

	var out []RoleChangeNotification
	for rows.Next() {
		var n RoleChangeNotification
		var premiumExpiresAt sql.NullTime
		if err := rows.Scan(
			&n.ID, &n.Username, &n.ChangedBy, &n.PreviousRole, &n.NewRole, &n.Reason,
			&premiumExpiresAt, &n.BlockFuturePremium, &n.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("ListRecentRoleChangeNotificationsForUser scan: %w", err)
		}
		if premiumExpiresAt.Valid {
			n.PremiumExpiresAt = &premiumExpiresAt.Time
		}
		out = append(out, n)
	}
	return out, rows.Err()
}
