package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// ── Node metric snapshots ───────────────────────────────────────────────────────

// GetNodeByHostname resolves a node by its Docker Swarm hostname. Returns nil if
// no node with that hostname is registered. Used by the node-metrics ingest
// endpoint to map an agent push to a node row.
func (q *Queries) GetNodeByHostname(ctx context.Context, hostname string) (*models.Node, error) {
	row := q.db.QueryRowContext(ctx,
		`SELECT`+nodeColumns+` FROM nodes WHERE hostname = $1`, hostname)
	n, err := scanNode(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetNodeByHostname: %w", err)
	}
	return n, nil
}

// InsertNodeSnapshot persists a per-node hardware snapshot and populates s.ID.
func (q *Queries) InsertNodeSnapshot(ctx context.Context, s *models.NodeMetricSnapshot) error {
	err := q.db.QueryRowContext(ctx, `
		INSERT INTO node_metrics_snapshots (
			id, node_id, cpu_percent, cpu_temp_celsius,
			memory_used_bytes, memory_total_bytes,
			network_bytes_sent, network_bytes_recv, sampled_at
		) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id
	`,
		s.NodeID, s.CPUPercent, s.CPUTempCelsius,
		s.MemoryUsedBytes, s.MemoryTotalBytes,
		s.NetworkBytesSent, s.NetworkBytesRecv, s.SampledAt,
	).Scan(&s.ID)
	if err != nil {
		return fmt.Errorf("InsertNodeSnapshot: %w", err)
	}
	return nil
}

// ListNodeSnapshotsByHours returns at most maxPoints evenly-distributed snapshots
// for one node from the past hours hours, ordered oldest-first. NTILE downsampling
// mirrors ListSnapshotsByHours so the graph covers the full interval.
func (q *Queries) ListNodeSnapshotsByHours(ctx context.Context, nodeID uuid.UUID, hours, maxPoints int) ([]models.NodeMetricSnapshot, error) {
	cutoff := time.Now().UTC().Add(-time.Duration(hours) * time.Hour)

	rows, err := q.db.QueryContext(ctx, `
		SELECT DISTINCT ON (bucket)
			id, node_id, cpu_percent, cpu_temp_celsius,
			memory_used_bytes, memory_total_bytes,
			network_bytes_sent, network_bytes_recv, sampled_at
		FROM (
			SELECT
				id, node_id, cpu_percent, cpu_temp_celsius,
				memory_used_bytes, memory_total_bytes,
				network_bytes_sent, network_bytes_recv, sampled_at,
				NTILE($1) OVER (ORDER BY sampled_at ASC) AS bucket
			FROM node_metrics_snapshots
			WHERE node_id = $2 AND sampled_at >= $3
		) sub
		ORDER BY bucket, sampled_at ASC
	`, maxPoints, nodeID, cutoff)
	if err != nil {
		return nil, fmt.Errorf("ListNodeSnapshotsByHours: %w", err)
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
			return nil, fmt.Errorf("ListNodeSnapshotsByHours scan: %w", err)
		}
		snaps = append(snaps, s)
	}
	return snaps, rows.Err()
}

// PruneOldNodeSnapshots deletes node snapshots sampled before the given time.
func (q *Queries) PruneOldNodeSnapshots(ctx context.Context, before time.Time) error {
	_, err := q.db.ExecContext(ctx,
		`DELETE FROM node_metrics_snapshots WHERE sampled_at < $1`, before)
	if err != nil {
		return fmt.Errorf("PruneOldNodeSnapshots: %w", err)
	}
	return nil
}

// ── Drive temperature snapshots ────────────────────────────────────────────────

// InsertDriveTemp persists one drive temperature reading.
func (q *Queries) InsertDriveTemp(ctx context.Context, driveID uuid.UUID, tempCelsius float64, sampledAt time.Time) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO drive_temp_snapshots (id, drive_id, temp_celsius, sampled_at)
		VALUES (gen_random_uuid(), $1, $2, $3)
	`, driveID, tempCelsius, sampledAt)
	if err != nil {
		return fmt.Errorf("InsertDriveTemp: %w", err)
	}
	return nil
}

// ListDriveTempsByHours returns at most maxPoints evenly-distributed temperature
// readings for one drive from the past hours hours, ordered oldest-first.
func (q *Queries) ListDriveTempsByHours(ctx context.Context, driveID uuid.UUID, hours, maxPoints int) ([]models.DriveTempSnapshot, error) {
	cutoff := time.Now().UTC().Add(-time.Duration(hours) * time.Hour)

	rows, err := q.db.QueryContext(ctx, `
		SELECT DISTINCT ON (bucket)
			id, drive_id, temp_celsius, sampled_at
		FROM (
			SELECT
				id, drive_id, temp_celsius, sampled_at,
				NTILE($1) OVER (ORDER BY sampled_at ASC) AS bucket
			FROM drive_temp_snapshots
			WHERE drive_id = $2 AND sampled_at >= $3
		) sub
		ORDER BY bucket, sampled_at ASC
	`, maxPoints, driveID, cutoff)
	if err != nil {
		return nil, fmt.Errorf("ListDriveTempsByHours: %w", err)
	}
	defer rows.Close()

	var snaps []models.DriveTempSnapshot
	for rows.Next() {
		var s models.DriveTempSnapshot
		if err := rows.Scan(&s.ID, &s.DriveID, &s.TempCelsius, &s.SampledAt); err != nil {
			return nil, fmt.Errorf("ListDriveTempsByHours scan: %w", err)
		}
		snaps = append(snaps, s)
	}
	return snaps, rows.Err()
}

// PruneOldDriveTemps deletes drive temperature readings sampled before the given time.
func (q *Queries) PruneOldDriveTemps(ctx context.Context, before time.Time) error {
	_, err := q.db.ExecContext(ctx,
		`DELETE FROM drive_temp_snapshots WHERE sampled_at < $1`, before)
	if err != nil {
		return fmt.Errorf("PruneOldDriveTemps: %w", err)
	}
	return nil
}
