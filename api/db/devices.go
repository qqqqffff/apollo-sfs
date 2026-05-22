package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Device mirrors a row in the devices table.
type Device struct {
	ID          uuid.UUID  `json:"id"`
	UserID      uuid.UUID  `json:"user_id"`
	Name        string     `json:"name"`
	Platform    string     `json:"platform"`
	PushToken   *string    `json:"push_token,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	LastSeenAt  time.Time  `json:"last_seen_at"`
}

func scanDevice(row *sql.Row) (*Device, error) {
	var d Device
	var pushToken sql.NullString
	if err := row.Scan(&d.ID, &d.UserID, &d.Name, &d.Platform, &pushToken, &d.CreatedAt, &d.LastSeenAt); err != nil {
		return nil, err
	}
	if pushToken.Valid {
		d.PushToken = &pushToken.String
	}
	return &d, nil
}

// CreateDevice inserts a new device row and returns it.
func (q *Queries) CreateDevice(ctx context.Context, userID uuid.UUID, name, platform string, pushToken *string) (*Device, error) {
	var pt sql.NullString
	if pushToken != nil {
		pt = sql.NullString{String: *pushToken, Valid: true}
	}
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO devices (user_id, name, platform, push_token)
		VALUES ($1, $2, $3, $4)
		RETURNING id, user_id, name, platform, push_token, created_at, last_seen_at
	`, userID, name, platform, pt)
	d, err := scanDevice(row)
	if err != nil {
		return nil, fmt.Errorf("CreateDevice: %w", err)
	}
	return d, nil
}

// GetDevice returns a device by ID.
func (q *Queries) GetDevice(ctx context.Context, id uuid.UUID) (*Device, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT id, user_id, name, platform, push_token, created_at, last_seen_at
		FROM devices WHERE id = $1
	`, id)
	d, err := scanDevice(row)
	if err != nil {
		return nil, fmt.Errorf("GetDevice %s: %w", id, err)
	}
	return d, nil
}

// UpdateDeviceLastSeen bumps last_seen_at to NOW() and optionally updates the push token.
func (q *Queries) UpdateDeviceLastSeen(ctx context.Context, id uuid.UUID, pushToken *string) error {
	var pt sql.NullString
	if pushToken != nil {
		pt = sql.NullString{String: *pushToken, Valid: true}
	}
	_, err := q.db.ExecContext(ctx, `
		UPDATE devices
		SET last_seen_at = NOW(),
		    push_token   = COALESCE($2, push_token)
		WHERE id = $1
	`, id, pt)
	if err != nil {
		return fmt.Errorf("UpdateDeviceLastSeen %s: %w", id, err)
	}
	return nil
}

// DeleteDevice removes a device row. Only the owning user should be able to
// call this (enforced at the handler layer).
func (q *Queries) DeleteDevice(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `DELETE FROM devices WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("DeleteDevice %s: %w", id, err)
	}
	return nil
}

// ListDevicesByUser returns all devices registered by a user.
func (q *Queries) ListDevicesByUser(ctx context.Context, userID uuid.UUID) ([]Device, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT id, user_id, name, platform, push_token, created_at, last_seen_at
		FROM devices WHERE user_id = $1 ORDER BY created_at ASC
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("ListDevicesByUser: %w", err)
	}
	defer rows.Close()

	var out []Device
	for rows.Next() {
		var d Device
		var pushToken sql.NullString
		if err := rows.Scan(&d.ID, &d.UserID, &d.Name, &d.Platform, &pushToken, &d.CreatedAt, &d.LastSeenAt); err != nil {
			return nil, fmt.Errorf("ListDevicesByUser scan: %w", err)
		}
		if pushToken.Valid {
			d.PushToken = &pushToken.String
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
