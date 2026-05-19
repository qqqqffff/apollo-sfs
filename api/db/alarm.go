package db

import (
	"context"
	"fmt"
	"time"

	"github.com/lib/pq"

	"apollo-sfs.com/api/models"
)

const alarmSelectCols = `
	cpu_usage_emails, cpu_usage_last_fired_at,
	cpu_temp_emails, cpu_temp_last_fired_at,
	drive_temp_emails, drive_temp_last_fired_at,
	drive_load_emails, drive_load_last_fired_at,
	network_traffic_emails, network_traffic_last_fired_at,
	api_error_rate_emails, api_error_rate_last_fired_at,
	updated_at`

// scanAlarmSettings scans a single alarm_settings row (must match alarmSelectCols order).
func scanAlarmSettings(row interface {
	Scan(...any) error
}) (*models.AlarmSettings, error) {
	var s models.AlarmSettings
	var (
		cpuUsage, cpuTemp, driveTemp, driveLoad, network, apiErr pq.StringArray
	)
	if err := row.Scan(
		&cpuUsage, &s.CPUUsageLastFiredAt,
		&cpuTemp, &s.CPUTempLastFiredAt,
		&driveTemp, &s.DriveTempLastFiredAt,
		&driveLoad, &s.DriveLoadLastFiredAt,
		&network, &s.NetworkTrafficLastFiredAt,
		&apiErr, &s.APIErrorRateLastFiredAt,
		&s.UpdatedAt,
	); err != nil {
		return nil, err
	}
	s.CPUUsageEmails = []string(cpuUsage)
	s.CPUTempEmails = []string(cpuTemp)
	s.DriveTempEmails = []string(driveTemp)
	s.DriveLoadEmails = []string(driveLoad)
	s.NetworkTrafficEmails = []string(network)
	s.APIErrorRateEmails = []string(apiErr)
	return &s, nil
}

// GetAlarmSettings returns the current alarm settings row (always id=1).
func (q *Queries) GetAlarmSettings(ctx context.Context) (*models.AlarmSettings, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT`+alarmSelectCols+`
		FROM alarm_settings WHERE id = 1
	`)
	s, err := scanAlarmSettings(row)
	if err != nil {
		return nil, fmt.Errorf("GetAlarmSettings: %w", err)
	}
	return s, nil
}

// SetAlarmSubscription adds or removes email from the named alarm's subscriber
// list and returns the updated settings row.
func (q *Queries) SetAlarmSubscription(ctx context.Context, alarmType, email string, subscribe bool) (*models.AlarmSettings, error) {
	col, err := alarmTypeColumn(alarmType)
	if err != nil {
		return nil, err
	}

	var query string
	if subscribe {
		// append only if not already present
		query = fmt.Sprintf(`
			UPDATE alarm_settings
			SET %s = array_append(%s, $1), updated_at = NOW()
			WHERE id = 1 AND NOT ($1 = ANY(%s))
			RETURNING`+alarmSelectCols, col, col, col)
	} else {
		query = fmt.Sprintf(`
			UPDATE alarm_settings
			SET %s = array_remove(%s, $1), updated_at = NOW()
			WHERE id = 1
			RETURNING`+alarmSelectCols, col, col)
	}

	row := q.db.QueryRowContext(ctx, query, email)
	s, err := scanAlarmSettings(row)
	if err != nil {
		// No rows updated means the email was already in/out of the list — re-fetch.
		s, refetchErr := q.GetAlarmSettings(ctx)
		if refetchErr != nil {
			return nil, fmt.Errorf("SetAlarmSubscription: %w", err)
		}
		return s, nil
	}
	return s, nil
}

// RecordAlarmFired sets the last_fired_at timestamp for the given alarm type.
func (q *Queries) RecordAlarmFired(ctx context.Context, alarmType string) error {
	col, err := alarmTypeColumn(alarmType)
	if err != nil {
		return err
	}
	firedCol := col[:len(col)-len("_emails")] + "_last_fired_at"
	_, execErr := q.db.ExecContext(ctx, fmt.Sprintf(`
		UPDATE alarm_settings SET %s = NOW() WHERE id = 1
	`, firedCol))
	return execErr
}

// alarmTypeColumn maps an alarm type string to its emails column name.
func alarmTypeColumn(alarmType string) (string, error) {
	switch alarmType {
	case "cpu_usage":
		return "cpu_usage_emails", nil
	case "cpu_temp":
		return "cpu_temp_emails", nil
	case "drive_temp":
		return "drive_temp_emails", nil
	case "drive_load":
		return "drive_load_emails", nil
	case "network_traffic":
		return "network_traffic_emails", nil
	case "api_error_rate":
		return "api_error_rate_emails", nil
	default:
		return "", fmt.Errorf("unknown alarm type: %q", alarmType)
	}
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
