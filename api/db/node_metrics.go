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

// ── Physical disks ─────────────────────────────────────────────────────────────

const nodeDiskColumns = `
	id, node_id, label, device, capacity_bytes, used_bytes, free_bytes, temp_celsius, last_seen_at, created_at`

func scanNodeDiskRow(rows *sql.Rows) (*models.NodeDisk, error) {
	var d models.NodeDisk
	var temp sql.NullFloat64
	if err := rows.Scan(&d.ID, &d.NodeID, &d.Label, &d.Device,
		&d.CapacityBytes, &d.UsedBytes, &d.FreeBytes, &temp,
		&d.LastSeenAt, &d.CreatedAt); err != nil {
		return nil, err
	}
	if temp.Valid {
		d.TempCelsius = &temp.Float64
	}
	return &d, nil
}

// UpsertNodeDiskParams carries one physical disk's reported figures.
type UpsertNodeDiskParams struct {
	NodeID        uuid.UUID
	Label         string
	Device        string
	CapacityBytes int64
	UsedBytes     int64
	FreeBytes     int64
	TempCelsius   *float64
}

// UpsertNodeDisk inserts or refreshes a physical disk keyed by (node_id, label),
// returning the row (with its stable ID, used to attach temperature history).
func (q *Queries) UpsertNodeDisk(ctx context.Context, p UpsertNodeDiskParams) (*models.NodeDisk, error) {
	rows, err := q.db.QueryContext(ctx, `
		INSERT INTO node_disks
			(node_id, label, device, capacity_bytes, used_bytes, free_bytes, temp_celsius, last_seen_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
		ON CONFLICT (node_id, label) DO UPDATE SET
			device         = EXCLUDED.device,
			capacity_bytes = EXCLUDED.capacity_bytes,
			used_bytes     = EXCLUDED.used_bytes,
			free_bytes     = EXCLUDED.free_bytes,
			temp_celsius   = EXCLUDED.temp_celsius,
			last_seen_at   = NOW()
		RETURNING`+nodeDiskColumns,
		p.NodeID, p.Label, p.Device, p.CapacityBytes, p.UsedBytes, p.FreeBytes, p.TempCelsius,
	)
	if err != nil {
		return nil, fmt.Errorf("UpsertNodeDisk: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("UpsertNodeDisk: %w", err)
		}
		return nil, fmt.Errorf("UpsertNodeDisk: no row returned")
	}
	return scanNodeDiskRow(rows)
}

// ListNodeDisks returns every physical disk reported for a node, ordered by label.
func (q *Queries) ListNodeDisks(ctx context.Context, nodeID uuid.UUID) ([]models.NodeDisk, error) {
	rows, err := q.db.QueryContext(ctx,
		`SELECT`+nodeDiskColumns+` FROM node_disks WHERE node_id = $1 ORDER BY label ASC`, nodeID)
	if err != nil {
		return nil, fmt.Errorf("ListNodeDisks: %w", err)
	}
	defer rows.Close()

	var out []models.NodeDisk
	for rows.Next() {
		d, err := scanNodeDiskRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListNodeDisks scan: %w", err)
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

// ListAllNodeDisks returns every physical disk reported across all nodes, ordered
// by node then label. Used by the infrastructure view to nest each node's
// physical disks under its logical drive.
func (q *Queries) ListAllNodeDisks(ctx context.Context) ([]models.NodeDisk, error) {
	rows, err := q.db.QueryContext(ctx,
		`SELECT`+nodeDiskColumns+` FROM node_disks ORDER BY node_id, label ASC`)
	if err != nil {
		return nil, fmt.Errorf("ListAllNodeDisks: %w", err)
	}
	defer rows.Close()

	var out []models.NodeDisk
	for rows.Next() {
		d, err := scanNodeDiskRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListAllNodeDisks scan: %w", err)
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

// InsertNodeDiskTemp persists one physical-disk temperature reading.
func (q *Queries) InsertNodeDiskTemp(ctx context.Context, diskID uuid.UUID, tempCelsius float64, sampledAt time.Time) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO node_disk_temp_snapshots (id, disk_id, temp_celsius, sampled_at)
		VALUES (gen_random_uuid(), $1, $2, $3)
	`, diskID, tempCelsius, sampledAt)
	if err != nil {
		return fmt.Errorf("InsertNodeDiskTemp: %w", err)
	}
	return nil
}

// ListNodeDiskTempsByHours returns at most maxPoints evenly-distributed
// temperature readings for one physical disk from the past hours hours,
// oldest-first. Mirrors ListDriveTempsByHours.
func (q *Queries) ListNodeDiskTempsByHours(ctx context.Context, diskID uuid.UUID, hours, maxPoints int) ([]models.NodeDiskTempSnapshot, error) {
	cutoff := time.Now().UTC().Add(-time.Duration(hours) * time.Hour)

	rows, err := q.db.QueryContext(ctx, `
		SELECT DISTINCT ON (bucket)
			id, disk_id, temp_celsius, sampled_at
		FROM (
			SELECT
				id, disk_id, temp_celsius, sampled_at,
				NTILE($1) OVER (ORDER BY sampled_at ASC) AS bucket
			FROM node_disk_temp_snapshots
			WHERE disk_id = $2 AND sampled_at >= $3
		) sub
		ORDER BY bucket, sampled_at ASC
	`, maxPoints, diskID, cutoff)
	if err != nil {
		return nil, fmt.Errorf("ListNodeDiskTempsByHours: %w", err)
	}
	defer rows.Close()

	var snaps []models.NodeDiskTempSnapshot
	for rows.Next() {
		var s models.NodeDiskTempSnapshot
		if err := rows.Scan(&s.ID, &s.DiskID, &s.TempCelsius, &s.SampledAt); err != nil {
			return nil, fmt.Errorf("ListNodeDiskTempsByHours scan: %w", err)
		}
		snaps = append(snaps, s)
	}
	return snaps, rows.Err()
}

// PruneOldNodeDiskTemps deletes physical-disk temperature readings sampled before
// the given time.
func (q *Queries) PruneOldNodeDiskTemps(ctx context.Context, before time.Time) error {
	_, err := q.db.ExecContext(ctx,
		`DELETE FROM node_disk_temp_snapshots WHERE sampled_at < $1`, before)
	if err != nil {
		return fmt.Errorf("PruneOldNodeDiskTemps: %w", err)
	}
	return nil
}
