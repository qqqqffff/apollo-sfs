package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// ErrNoCapacity is returned when no active drive has enough free quota space
// to accommodate the requested allocation.
var ErrNoCapacity = errors.New("no drive has sufficient capacity for the requested quota")

// ── Drives ────────────────────────────────────────────────────────────────────

const driveColumns = `
	id, server_id, label, capacity_bytes, minio_bucket, is_active, created_at`

func scanDrive(row *sql.Row) (*models.Drive, error) {
	var d models.Drive
	err := row.Scan(&d.ID, &d.ServerID, &d.Label, &d.CapacityBytes,
		&d.MinioBucket, &d.IsActive, &d.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func scanDriveRow(rows *sql.Rows) (*models.Drive, error) {
	var d models.Drive
	err := rows.Scan(&d.ID, &d.ServerID, &d.Label, &d.CapacityBytes,
		&d.MinioBucket, &d.IsActive, &d.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// ListDrives returns all drives for a server, ordered by label ASC.
func (q *Queries) ListDrives(ctx context.Context, serverID uuid.UUID) ([]models.Drive, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT`+driveColumns+`
		FROM drives WHERE server_id = $1
		ORDER BY label ASC
	`, serverID)
	if err != nil {
		return nil, fmt.Errorf("ListDrives: %w", err)
	}
	defer rows.Close()

	var out []models.Drive
	for rows.Next() {
		d, err := scanDriveRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListDrives scan: %w", err)
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

// GetDrive fetches a single drive by ID.
func (q *Queries) GetDrive(ctx context.Context, id uuid.UUID) (*models.Drive, error) {
	row := q.db.QueryRowContext(ctx,
		`SELECT`+driveColumns+`FROM drives WHERE id = $1`, id)
	d, err := scanDrive(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetDrive: %w", err)
	}
	return d, nil
}

// CreateDriveParams carries all fields needed to insert a new drive row.
type CreateDriveParams struct {
	ServerID      uuid.UUID
	Label         string
	CapacityBytes int64
	MinioBucket   string
}

// CreateDrive inserts a new drive and returns the created row.
func (q *Queries) CreateDrive(ctx context.Context, p CreateDriveParams) (*models.Drive, error) {
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO drives (server_id, label, capacity_bytes, minio_bucket)
		VALUES ($1, $2, $3, $4)
		RETURNING`+driveColumns,
		p.ServerID, p.Label, p.CapacityBytes, p.MinioBucket,
	)
	d, err := scanDrive(row)
	if err != nil {
		return nil, fmt.Errorf("CreateDrive: %w", err)
	}
	return d, nil
}

// UpdateDriveParams carries updateable fields for a drive.
type UpdateDriveParams struct {
	Label         string
	CapacityBytes int64
	IsActive      bool
}

// UpdateDrive updates label, capacity and active flag for a drive.
func (q *Queries) UpdateDrive(ctx context.Context, id uuid.UUID, p UpdateDriveParams) (*models.Drive, error) {
	row := q.db.QueryRowContext(ctx, `
		UPDATE drives SET label = $2, capacity_bytes = $3, is_active = $4
		WHERE id = $1
		RETURNING`+driveColumns,
		id, p.Label, p.CapacityBytes, p.IsActive,
	)
	d, err := scanDrive(row)
	if err != nil {
		return nil, fmt.Errorf("UpdateDrive: %w", err)
	}
	return d, nil
}

// ── Capacity queries ──────────────────────────────────────────────────────────

// GetDriveAvailableBytes returns the unallocated capacity on a drive:
// capacity_bytes − SUM(storage_quota_bytes) for all users on this drive.
// The result is the maximum additional quota that can be allocated here.
func (q *Queries) GetDriveAvailableBytes(ctx context.Context, driveID uuid.UUID) (int64, error) {
	var avail int64
	err := q.db.QueryRowContext(ctx, `
		SELECT d.capacity_bytes - COALESCE(SUM(u.storage_quota_bytes), 0)
		FROM drives d
		LEFT JOIN user_drive_allocations uda ON uda.drive_id = d.id
		LEFT JOIN users u ON u.username = uda.user_id
		WHERE d.id = $1
		GROUP BY d.capacity_bytes
	`, driveID).Scan(&avail)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("GetDriveAvailableBytes: %w", err)
	}
	return avail, nil
}

// SelectDriveForQuota finds the best-fit active drive that can accommodate
// quotaBytes of additional allocation (smallest remaining capacity that still
// fits). Returns ErrNoCapacity if no drive qualifies.
func (q *Queries) SelectDriveForQuota(ctx context.Context, quotaBytes int64) (*models.Drive, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT`+driveColumns+`
		FROM drives d
		JOIN servers s ON s.id = d.server_id
		LEFT JOIN user_drive_allocations uda ON uda.drive_id = d.id
		LEFT JOIN users u ON u.username = uda.user_id
		WHERE d.is_active = true AND s.is_active = true
		GROUP BY d.id
		HAVING d.capacity_bytes - COALESCE(SUM(u.storage_quota_bytes), 0) >= $1
		ORDER BY (d.capacity_bytes - COALESCE(SUM(u.storage_quota_bytes), 0)) ASC
		LIMIT 1
	`, quotaBytes)
	d, err := scanDrive(row)
	if err == sql.ErrNoRows {
		return nil, ErrNoCapacity
	}
	if err != nil {
		return nil, fmt.Errorf("SelectDriveForQuota: %w", err)
	}
	return d, nil
}

// GetMaxAvailableQuota returns the largest quota that could currently be
// allocated to a single new user (= most available space on any single drive).
func (q *Queries) GetMaxAvailableQuota(ctx context.Context) (int64, error) {
	var max int64
	err := q.db.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(d.capacity_bytes - COALESCE(sub.allocated, 0)), 0)
		FROM drives d
		JOIN servers s ON s.id = d.server_id
		LEFT JOIN (
			SELECT uda.drive_id, SUM(u.storage_quota_bytes) AS allocated
			FROM user_drive_allocations uda
			JOIN users u ON u.username = uda.user_id
			GROUP BY uda.drive_id
		) sub ON sub.drive_id = d.id
		WHERE d.is_active = true AND s.is_active = true
	`).Scan(&max)
	if err != nil {
		return 0, fmt.Errorf("GetMaxAvailableQuota: %w", err)
	}
	return max, nil
}

// ── User drive allocations ────────────────────────────────────────────────────

// GetUserDrive returns the drive allocation for a user with the drive and
// server details populated. Returns nil if the user has no allocation.
func (q *Queries) GetUserDrive(ctx context.Context, username string) (*models.UserDriveAllocation, error) {
	var a models.UserDriveAllocation
	err := q.db.QueryRowContext(ctx, `
		SELECT
			uda.user_id, uda.drive_id, uda.allocated_at,
			d.id, d.server_id, d.label, d.capacity_bytes, d.minio_bucket, d.is_active, d.created_at,
			s.id, s.name, s.state, s.minio_endpoint, s.minio_use_ssl,
			s.minio_access_key_enc, s.minio_access_key_nonce,
			s.minio_secret_key_enc, s.minio_secret_key_nonce,
			s.is_active, s.created_at
		FROM user_drive_allocations uda
		JOIN drives d ON d.id = uda.drive_id
		JOIN servers s ON s.id = d.server_id
		WHERE uda.user_id = $1
	`, username).Scan(
		&a.UserID, &a.DriveID, &a.AllocatedAt,
		&a.Drive.ID, &a.Drive.ServerID, &a.Drive.Label, &a.Drive.CapacityBytes,
		&a.Drive.MinioBucket, &a.Drive.IsActive, &a.Drive.CreatedAt,
		&a.Server.ID, &a.Server.Name, &a.Server.State, &a.Server.MinioEndpoint,
		&a.Server.MinioUseSSL,
		&a.Server.MinioAccessKeyEnc, &a.Server.MinioAccessKeyNonce,
		&a.Server.MinioSecretKeyEnc, &a.Server.MinioSecretKeyNonce,
		&a.Server.IsActive, &a.Server.CreatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetUserDrive: %w", err)
	}
	return &a, nil
}

// AllocateUserToDrive inserts (or replaces on conflict) a user's drive mapping.
func (q *Queries) AllocateUserToDrive(ctx context.Context, username string, driveID uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO user_drive_allocations (user_id, drive_id)
		VALUES ($1, $2)
		ON CONFLICT (user_id) DO UPDATE SET drive_id = EXCLUDED.drive_id, allocated_at = NOW()
	`, username, driveID)
	if err != nil {
		return fmt.Errorf("AllocateUserToDrive: %w", err)
	}
	return nil
}

// GetDriveSummaries returns per-drive usage stats for the infrastructure view.
func (q *Queries) GetDriveSummaries(ctx context.Context) ([]models.DriveSummary, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT
			d.id, d.server_id, s.name, d.label, d.capacity_bytes, d.minio_bucket,
			COALESCE(SUM(u.storage_quota_bytes), 0) AS allocated_quota_bytes,
			COALESCE(SUM(u.storage_used_bytes), 0)  AS used_bytes,
			d.is_active, s.is_active
		FROM drives d
		JOIN servers s ON s.id = d.server_id
		LEFT JOIN user_drive_allocations uda ON uda.drive_id = d.id
		LEFT JOIN users u ON u.username = uda.user_id
		GROUP BY d.id, s.id
		ORDER BY s.name ASC, d.label ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("GetDriveSummaries: %w", err)
	}
	defer rows.Close()

	var out []models.DriveSummary
	for rows.Next() {
		var ds models.DriveSummary
		if err := rows.Scan(
			&ds.DriveID, &ds.ServerID, &ds.ServerName, &ds.DriveLabel,
			&ds.CapacityBytes, &ds.MinioBucket,
			&ds.AllocatedQuotaBytes, &ds.UsedBytes,
			&ds.DriveIsActive, &ds.ServerIsActive,
		); err != nil {
			return nil, fmt.Errorf("GetDriveSummaries scan: %w", err)
		}
		out = append(out, ds)
	}
	return out, rows.Err()
}
