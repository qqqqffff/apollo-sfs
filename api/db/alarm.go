package db

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// alarmSubColumns lists alarm_subscriptions columns joined with display fields
// from nodes / drives / servers (NULL when the target dimension is unused).
const alarmSubColumns = `
	s.id, s.email, s.alarm_type, s.node_id, s.drive_id, s.threshold, s.last_fired_at,
	COALESCE(n.hostname, ''), COALESCE(n.role, ''),
	COALESCE(d.label, ''),
	COALESCE(ns.name, ds.name, '')`

const alarmSubFrom = `
	FROM alarm_subscriptions s
	LEFT JOIN nodes   n  ON n.id = s.node_id
	LEFT JOIN servers ns ON ns.id = n.server_id
	LEFT JOIN drives  d  ON d.id = s.drive_id
	LEFT JOIN servers ds ON ds.id = d.server_id`

func scanAlarmSubscription(rows interface {
	Scan(...any) error
}) (*models.AlarmSubscription, error) {
	var s models.AlarmSubscription
	if err := rows.Scan(
		&s.ID, &s.Email, &s.AlarmType, &s.NodeID, &s.DriveID, &s.Threshold, &s.LastFiredAt,
		&s.NodeHostname, &s.NodeRole, &s.DriveLabel, &s.ServerName,
	); err != nil {
		return nil, err
	}
	return &s, nil
}

// ListAlarmSubscriptions returns every alarm subscription with its target
// display fields. Used by the alarm evaluator.
func (q *Queries) ListAlarmSubscriptions(ctx context.Context) ([]models.AlarmSubscription, error) {
	rows, err := q.db.QueryContext(ctx, `SELECT`+alarmSubColumns+alarmSubFrom+` ORDER BY s.alarm_type`)
	if err != nil {
		return nil, fmt.Errorf("ListAlarmSubscriptions: %w", err)
	}
	defer rows.Close()
	return collectAlarmSubscriptions(rows)
}

// ListAlarmSubscriptionsByEmail returns one subscriber's alarm subscriptions.
// Backs the metrics page (current user) and the admin review page (any user).
func (q *Queries) ListAlarmSubscriptionsByEmail(ctx context.Context, email string) ([]models.AlarmSubscription, error) {
	rows, err := q.db.QueryContext(ctx, `SELECT`+alarmSubColumns+alarmSubFrom+`
		WHERE s.email = $1 ORDER BY s.alarm_type`, email)
	if err != nil {
		return nil, fmt.Errorf("ListAlarmSubscriptionsByEmail: %w", err)
	}
	defer rows.Close()
	return collectAlarmSubscriptions(rows)
}

func collectAlarmSubscriptions(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
}) ([]models.AlarmSubscription, error) {
	var subs []models.AlarmSubscription
	for rows.Next() {
		s, err := scanAlarmSubscription(rows)
		if err != nil {
			return nil, fmt.Errorf("scan alarm subscription: %w", err)
		}
		subs = append(subs, *s)
	}
	return subs, rows.Err()
}

// UpsertAlarmSubscription creates or updates a subscription's threshold for the
// given (email, alarm_type, target) tuple and returns the stored row.
func (q *Queries) UpsertAlarmSubscription(ctx context.Context, email, alarmType string, nodeID, driveID *uuid.UUID, threshold float64) (*models.AlarmSubscription, error) {
	var id uuid.UUID
	err := q.db.QueryRowContext(ctx, `
		INSERT INTO alarm_subscriptions (email, alarm_type, node_id, drive_id, threshold)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (email, alarm_type,
			COALESCE(node_id,  '00000000-0000-0000-0000-000000000000'::uuid),
			COALESCE(drive_id, '00000000-0000-0000-0000-000000000000'::uuid))
		DO UPDATE SET threshold = EXCLUDED.threshold, updated_at = now()
		RETURNING id
	`, email, alarmType, nodeID, driveID, threshold).Scan(&id)
	if err != nil {
		return nil, fmt.Errorf("UpsertAlarmSubscription: %w", err)
	}

	row := q.db.QueryRowContext(ctx, `SELECT`+alarmSubColumns+alarmSubFrom+` WHERE s.id = $1`, id)
	s, err := scanAlarmSubscription(row)
	if err != nil {
		return nil, fmt.Errorf("UpsertAlarmSubscription reload: %w", err)
	}
	return s, nil
}

// DeleteAlarmSubscription removes the subscription matching the (email,
// alarm_type, target) tuple. NULL targets are matched with the zero-UUID
// sentinel so cluster-wide rows can be deleted too.
func (q *Queries) DeleteAlarmSubscription(ctx context.Context, email, alarmType string, nodeID, driveID *uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		DELETE FROM alarm_subscriptions
		WHERE email = $1 AND alarm_type = $2
		  AND COALESCE(node_id,  '00000000-0000-0000-0000-000000000000'::uuid)
		    = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
		  AND COALESCE(drive_id, '00000000-0000-0000-0000-000000000000'::uuid)
		    = COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
	`, email, alarmType, nodeID, driveID)
	if err != nil {
		return fmt.Errorf("DeleteAlarmSubscription: %w", err)
	}
	return nil
}

// RecordAlarmSubscriptionFired stamps last_fired_at on a single subscription so
// its cooldown is tracked per row.
func (q *Queries) RecordAlarmSubscriptionFired(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE alarm_subscriptions SET last_fired_at = now() WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("RecordAlarmSubscriptionFired: %w", err)
	}
	return nil
}

// ListNodeSnapshotsWindow returns all raw per-node snapshots for one node within
// the past window duration, ordered oldest-first. Per-node sibling of
// ListSnapshotsWindow used by the alarm evaluator for node-scoped alarms.
func (q *Queries) ListNodeSnapshotsWindow(ctx context.Context, nodeID uuid.UUID, window time.Duration) ([]models.NodeMetricSnapshot, error) {
	cutoff := time.Now().UTC().Add(-window)
	rows, err := q.db.QueryContext(ctx, `
		SELECT id, node_id, cpu_percent, cpu_temp_celsius,
			memory_used_bytes, memory_total_bytes,
			network_bytes_sent, network_bytes_recv, sampled_at
		FROM node_metrics_snapshots
		WHERE node_id = $1 AND sampled_at >= $2
		ORDER BY sampled_at ASC
	`, nodeID, cutoff)
	if err != nil {
		return nil, fmt.Errorf("ListNodeSnapshotsWindow: %w", err)
	}
	defer rows.Close()

	var snaps []models.NodeMetricSnapshot
	for rows.Next() {
		var s models.NodeMetricSnapshot
		if err := rows.Scan(
			&s.ID, &s.NodeID, &s.CPUPercent, &s.CPUTempCelsius,
			&s.MemoryUsedBytes, &s.MemoryTotalBytes,
			&s.NetworkBytesSent, &s.NetworkBytesRecv, &s.SampledAt,
		); err != nil {
			return nil, fmt.Errorf("ListNodeSnapshotsWindow scan: %w", err)
		}
		snaps = append(snaps, s)
	}
	return snaps, rows.Err()
}

// ListDriveTempsWindow returns all raw temperature readings for one drive within
// the past window duration, ordered oldest-first. Per-drive sibling of
// ListDriveTempsByHours used by the alarm evaluator for drive_temp alarms.
func (q *Queries) ListDriveTempsWindow(ctx context.Context, driveID uuid.UUID, window time.Duration) ([]models.DriveTempSnapshot, error) {
	cutoff := time.Now().UTC().Add(-window)
	rows, err := q.db.QueryContext(ctx, `
		SELECT id, drive_id, temp_celsius, sampled_at
		FROM drive_temp_snapshots
		WHERE drive_id = $1 AND sampled_at >= $2
		ORDER BY sampled_at ASC
	`, driveID, cutoff)
	if err != nil {
		return nil, fmt.Errorf("ListDriveTempsWindow: %w", err)
	}
	defer rows.Close()

	var snaps []models.DriveTempSnapshot
	for rows.Next() {
		var s models.DriveTempSnapshot
		if err := rows.Scan(&s.ID, &s.DriveID, &s.TempCelsius, &s.SampledAt); err != nil {
			return nil, fmt.Errorf("ListDriveTempsWindow scan: %w", err)
		}
		snaps = append(snaps, s)
	}
	return snaps, rows.Err()
}
