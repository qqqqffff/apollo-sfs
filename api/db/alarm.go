package db

import (
	"context"
	"fmt"
	"time"

	"github.com/lib/pq"

	"apollo-sfs.com/api/models"
)

// GetAlarmSettings returns the current alarm settings row (always id=1).
func (q *Queries) GetAlarmSettings(ctx context.Context) (*models.AlarmSettings, error) {
	var s models.AlarmSettings
	var emails pq.StringArray
	err := q.db.QueryRowContext(ctx, `
		SELECT notify_emails,
		       cpu_usage_enabled, cpu_temp_enabled,
		       drive_temp_enabled, drive_load_enabled,
		       network_traffic_enabled, api_error_rate_enabled,
		       updated_at
		FROM alarm_settings WHERE id = 1
	`).Scan(
		&emails,
		&s.CPUUsageEnabled, &s.CPUTempEnabled,
		&s.DriveTempEnabled, &s.DriveLoadEnabled,
		&s.NetworkTrafficEnabled, &s.APIErrorRateEnabled,
		&s.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("GetAlarmSettings: %w", err)
	}
	s.NotifyEmails = []string(emails)
	return &s, nil
}

// UpdateAlarmSettingsParams carries all mutable fields for the alarm settings row.
type UpdateAlarmSettingsParams struct {
	NotifyEmails          []string
	CPUUsageEnabled       bool
	CPUTempEnabled        bool
	DriveTempEnabled      bool
	DriveLoadEnabled      bool
	NetworkTrafficEnabled bool
	APIErrorRateEnabled   bool
}

// UpdateAlarmSettings replaces every field in the alarm settings row and
// returns the updated row.
func (q *Queries) UpdateAlarmSettings(ctx context.Context, p UpdateAlarmSettingsParams) (*models.AlarmSettings, error) {
	var s models.AlarmSettings
	var emails pq.StringArray
	err := q.db.QueryRowContext(ctx, `
		UPDATE alarm_settings
		SET notify_emails           = $1,
		    cpu_usage_enabled       = $2,
		    cpu_temp_enabled        = $3,
		    drive_temp_enabled      = $4,
		    drive_load_enabled      = $5,
		    network_traffic_enabled = $6,
		    api_error_rate_enabled  = $7,
		    updated_at              = NOW()
		WHERE id = 1
		RETURNING notify_emails,
		          cpu_usage_enabled, cpu_temp_enabled,
		          drive_temp_enabled, drive_load_enabled,
		          network_traffic_enabled, api_error_rate_enabled,
		          updated_at
	`,
		pq.Array(p.NotifyEmails),
		p.CPUUsageEnabled, p.CPUTempEnabled,
		p.DriveTempEnabled, p.DriveLoadEnabled,
		p.NetworkTrafficEnabled, p.APIErrorRateEnabled,
	).Scan(
		&emails,
		&s.CPUUsageEnabled, &s.CPUTempEnabled,
		&s.DriveTempEnabled, &s.DriveLoadEnabled,
		&s.NetworkTrafficEnabled, &s.APIErrorRateEnabled,
		&s.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("UpdateAlarmSettings: %w", err)
	}
	s.NotifyEmails = []string(emails)
	return &s, nil
}

// ListSnapshotsWindow returns all raw snapshots sampled within the past
// window duration, ordered oldest-first. Used by the alarm service to
// evaluate sustained-threshold conditions without downsampling.
func (q *Queries) ListSnapshotsWindow(ctx context.Context, window time.Duration) ([]models.ServerMetricSnapshot, error) {
	cutoff := time.Now().UTC().Add(-window)
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+snapshotColumns+`
		FROM server_metrics_snapshots
		WHERE sampled_at >= $1
		ORDER BY sampled_at ASC
	`, cutoff)
	if err != nil {
		return nil, fmt.Errorf("ListSnapshotsWindow: %w", err)
	}
	defer rows.Close()

	var snaps []models.ServerMetricSnapshot
	for rows.Next() {
		s, err := scanSnapshot(rows)
		if err != nil {
			return nil, fmt.Errorf("ListSnapshotsWindow scan: %w", err)
		}
		snaps = append(snaps, *s)
	}
	return snaps, rows.Err()
}
