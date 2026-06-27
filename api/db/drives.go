package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/lib/pq"

	"apollo-sfs.com/api/models"
)

// ErrNoCapacity is returned when no active drive has enough free quota space
// to accommodate the requested allocation.
var ErrNoCapacity = errors.New("no drive has sufficient capacity for the requested quota")

// ── Drives ────────────────────────────────────────────────────────────────────

const driveColumns = `
	id, server_id, node_id, label, capacity_bytes, minio_bucket, drive_type, is_active, created_at`

func scanDrive(row *sql.Row) (*models.Drive, error) {
	var d models.Drive
	err := row.Scan(&d.ID, &d.ServerID, &d.NodeID, &d.Label, &d.CapacityBytes,
		&d.MinioBucket, &d.DriveType, &d.IsActive, &d.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func scanDriveRow(rows *sql.Rows) (*models.Drive, error) {
	var d models.Drive
	err := rows.Scan(&d.ID, &d.ServerID, &d.NodeID, &d.Label, &d.CapacityBytes,
		&d.MinioBucket, &d.DriveType, &d.IsActive, &d.CreatedAt)
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
		`SELECT`+driveColumns+` FROM drives WHERE id = $1`, id)
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
// NodeID is optional — nil leaves the drive unassigned to a node.
type CreateDriveParams struct {
	ServerID      uuid.UUID
	NodeID        *uuid.UUID
	Label         string
	CapacityBytes int64
	MinioBucket   string
	DriveType     string // "nvme" (fast) or "hdd" (standard)
}

// CreateDrive inserts a new drive and returns the created row.
func (q *Queries) CreateDrive(ctx context.Context, p CreateDriveParams) (*models.Drive, error) {
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO drives (server_id, node_id, label, capacity_bytes, minio_bucket, drive_type)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING`+driveColumns,
		p.ServerID, p.NodeID, p.Label, p.CapacityBytes, p.MinioBucket, p.DriveType,
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

// DeleteDrive removes a drive record. Returns an error if any users are
// currently allocated to it; the caller must reassign them first.
func (q *Queries) DeleteDrive(ctx context.Context, id uuid.UUID) error {
	var count int
	if err := q.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM user_drive_allocations WHERE drive_id = $1`, id,
	).Scan(&count); err != nil {
		return fmt.Errorf("DeleteDrive: check allocations: %w", err)
	}
	if count > 0 {
		return fmt.Errorf("DeleteDrive: drive has %d user allocations; reassign them first", count)
	}
	_, err := q.db.ExecContext(ctx, `DELETE FROM drives WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("DeleteDrive: %w", err)
	}
	return nil
}

// UpsertDriveParams carries all fields needed to insert-or-update a drive during
// an infrastructure sync, keyed by (server_id, minio_bucket).
type UpsertDriveParams struct {
	ServerID      uuid.UUID
	NodeID        *uuid.UUID
	Label         string
	CapacityBytes int64
	MinioBucket   string
	DriveType     string
	IsActive      bool
}

// UpsertDrive inserts a drive, or updates its node/label/capacity/type/active
// flag when one already exists for (server_id, minio_bucket). Returns the
// resulting row. Used by the infrastructure sync to reconcile discovered buckets
// idempotently. Capacity is refreshed here (unlike UpdateDrive) because the sync
// is the authoritative source for it.
func (q *Queries) UpsertDrive(ctx context.Context, p UpsertDriveParams) (*models.Drive, error) {
	driveType := p.DriveType
	if driveType == "" {
		driveType = "hdd"
	}
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO drives (server_id, node_id, label, capacity_bytes, minio_bucket, drive_type, is_active)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (server_id, minio_bucket)
		DO UPDATE SET
			node_id        = EXCLUDED.node_id,
			label          = EXCLUDED.label,
			capacity_bytes = EXCLUDED.capacity_bytes,
			drive_type     = EXCLUDED.drive_type,
			is_active      = EXCLUDED.is_active
		RETURNING`+driveColumns,
		p.ServerID, p.NodeID, p.Label, p.CapacityBytes, p.MinioBucket, driveType, p.IsActive,
	)
	d, err := scanDrive(row)
	if err != nil {
		return nil, fmt.Errorf("UpsertDrive: %w", err)
	}
	return d, nil
}

// DeactivateMissingDrives marks every drive of a server inactive except those
// whose ID is in keepIDs. Used by the sync to retire drives whose buckets have
// disappeared without deleting them (preserving user allocations). A nil/empty
// keepIDs deactivates all of the server's drives.
func (q *Queries) DeactivateMissingDrives(ctx context.Context, serverID uuid.UUID, keepIDs []uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE drives SET is_active = false
		WHERE server_id = $1 AND is_active = true AND NOT (id = ANY($2::uuid[]))
	`, serverID, pq.Array(keepIDs))
	if err != nil {
		return fmt.Errorf("DeactivateMissingDrives: %w", err)
	}
	return nil
}

// UpdateDriveCapacity sets the capacity_bytes for a drive and returns the
// updated row. Used by the sync-capacity endpoint to auto-detect disk size.
func (q *Queries) UpdateDriveCapacity(ctx context.Context, id uuid.UUID, capacityBytes int64) (*models.Drive, error) {
	row := q.db.QueryRowContext(ctx, `
		UPDATE drives SET capacity_bytes = $2 WHERE id = $1 RETURNING`+driveColumns,
		id, capacityBytes,
	)
	d, err := scanDrive(row)
	if err != nil {
		return nil, fmt.Errorf("UpdateDriveCapacity: %w", err)
	}
	return d, nil
}

// AutoSyncDriveCapacities sets capacity_bytes = capacityBytes for every drive
// where capacity_bytes is currently 0 (i.e. never synced). Called at startup
// so that newly-added drives get the real disk size without needing a manual Sync.
func (q *Queries) AutoSyncDriveCapacities(ctx context.Context, capacityBytes int64) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE drives SET capacity_bytes = $1 WHERE capacity_bytes = 0`, capacityBytes)
	if err != nil {
		return fmt.Errorf("AutoSyncDriveCapacities: %w", err)
	}
	return nil
}

// SyncAllDriveCapacities updates capacity_bytes for ALL drives unconditionally.
// Used at startup to ensure the stored capacity always reflects the actual disk size.
func (q *Queries) SyncAllDriveCapacities(ctx context.Context, capacityBytes int64) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE drives SET capacity_bytes = $1`, capacityBytes)
	if err != nil {
		return fmt.Errorf("SyncAllDriveCapacities: %w", err)
	}
	return nil
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
		SELECT COALESCE(MAX(GREATEST(d.capacity_bytes - COALESCE(sub.allocated, 0), 0)), 0)
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

// GetUserDrive returns a user's PRIMARY drive allocation with the drive and
// server details populated. When a user has multiple allocations the primary
// one wins; with none marked it falls back to the oldest. Returns nil if the
// user has no allocation.
func (q *Queries) GetUserDrive(ctx context.Context, username string) (*models.UserDriveAllocation, error) {
	var a models.UserDriveAllocation
	err := q.db.QueryRowContext(ctx, `
		SELECT
			uda.user_id, uda.drive_id, uda.is_primary, uda.allocated_at,
			d.id, d.server_id, d.node_id, d.label, d.capacity_bytes, d.minio_bucket, d.drive_type, d.is_active, d.created_at,
			s.id, s.name, s.state, s.minio_endpoint, s.minio_use_ssl,
			s.minio_access_key_enc, s.minio_access_key_nonce,
			s.minio_secret_key_enc, s.minio_secret_key_nonce,
			s.is_active, s.created_at
		FROM user_drive_allocations uda
		JOIN drives d ON d.id = uda.drive_id
		JOIN servers s ON s.id = d.server_id
		WHERE uda.user_id = $1
		ORDER BY uda.is_primary DESC, uda.allocated_at ASC
		LIMIT 1
	`, username).Scan(
		&a.UserID, &a.DriveID, &a.IsPrimary, &a.AllocatedAt,
		&a.Drive.ID, &a.Drive.ServerID, &a.Drive.NodeID, &a.Drive.Label, &a.Drive.CapacityBytes,
		&a.Drive.MinioBucket, &a.Drive.DriveType, &a.Drive.IsActive, &a.Drive.CreatedAt,
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

// GetDriveWithServer returns a single drive and its server, for resolving the
// MinIO client of the drive a given file lives on.
func (q *Queries) GetDriveWithServer(ctx context.Context, driveID uuid.UUID) (*models.UserDriveAllocation, error) {
	var a models.UserDriveAllocation
	err := q.db.QueryRowContext(ctx, `
		SELECT
			d.id, d.server_id, d.node_id, d.label, d.capacity_bytes, d.minio_bucket, d.drive_type, d.is_active, d.created_at,
			s.id, s.name, s.state, s.minio_endpoint, s.minio_use_ssl,
			s.minio_access_key_enc, s.minio_access_key_nonce,
			s.minio_secret_key_enc, s.minio_secret_key_nonce,
			s.is_active, s.created_at
		FROM drives d
		JOIN servers s ON s.id = d.server_id
		WHERE d.id = $1
	`, driveID).Scan(
		&a.Drive.ID, &a.Drive.ServerID, &a.Drive.NodeID, &a.Drive.Label, &a.Drive.CapacityBytes,
		&a.Drive.MinioBucket, &a.Drive.DriveType, &a.Drive.IsActive, &a.Drive.CreatedAt,
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
		return nil, fmt.Errorf("GetDriveWithServer: %w", err)
	}
	a.DriveID = a.Drive.ID
	return &a, nil
}

// UserDriveInfo summarizes one of a user's drive allocations: physical fullness
// (across all users on the drive) for routing/availability, and this user's own
// used bytes for the per-server UI bar.
type UserDriveInfo struct {
	DriveID        uuid.UUID
	ServerID       uuid.UUID
	ServerName     string
	ServerState    string
	ServerIsActive bool
	DriveLabel     string
	DriveType      string // "nvme" | "hdd"
	CapacityBytes  int64
	DriveUsedBytes int64 // sum across all users on the drive
	UserUsedBytes  int64 // this user's files on the drive
	IsPrimary      bool
	DriveIsActive  bool
}

// GetUserDrives returns all of a user's drive allocations with usage stats,
// primary first. Used for upload routing (primary + least-%-used fallback) and
// the per-server storage UI.
func (q *Queries) GetUserDrives(ctx context.Context, username string) ([]UserDriveInfo, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT
			d.id, d.server_id, s.name, s.state, s.is_active,
			d.label,
			d.drive_type,
			d.capacity_bytes,
			COALESCE(du.bytes, 0) AS drive_used,
			COALESCE(uu.bytes, 0) AS user_used,
			uda.is_primary, d.is_active
		FROM user_drive_allocations uda
		JOIN drives d ON d.id = uda.drive_id
		JOIN servers s ON s.id = d.server_id
		LEFT JOIN (SELECT drive_id, SUM(size_bytes) AS bytes FROM files GROUP BY drive_id) du ON du.drive_id = d.id
		LEFT JOIN (SELECT drive_id, SUM(size_bytes) AS bytes FROM files WHERE user_id = $1::uuid GROUP BY drive_id) uu ON uu.drive_id = d.id
		WHERE uda.user_id = $1
		ORDER BY uda.is_primary DESC, s.name ASC
	`, username)
	if err != nil {
		return nil, fmt.Errorf("GetUserDrives: %w", err)
	}
	defer rows.Close()

	var out []UserDriveInfo
	for rows.Next() {
		var d UserDriveInfo
		if err := rows.Scan(
			&d.DriveID, &d.ServerID, &d.ServerName, &d.ServerState, &d.ServerIsActive,
			&d.DriveLabel, &d.DriveType, &d.CapacityBytes,
			&d.DriveUsedBytes, &d.UserUsedBytes, &d.IsPrimary, &d.DriveIsActive,
		); err != nil {
			return nil, fmt.Errorf("GetUserDrives scan: %w", err)
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// AllocateUserToDrive sets a user's PRIMARY drive (used at registration and when
// switching the primary). It clears any existing primary first, then upserts the
// target as primary, all in one transaction to satisfy the one-primary index.
func (q *Queries) AllocateUserToDrive(ctx context.Context, username string, driveID uuid.UUID) error {
	tx, err := q.pool.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("AllocateUserToDrive: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx,
		`UPDATE user_drive_allocations SET is_primary = false WHERE user_id = $1 AND is_primary`,
		username,
	); err != nil {
		return fmt.Errorf("AllocateUserToDrive: clear primary: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_drive_allocations (user_id, drive_id, is_primary)
		VALUES ($1, $2, true)
		ON CONFLICT (user_id, drive_id) DO UPDATE SET is_primary = true, allocated_at = NOW()
	`, username, driveID); err != nil {
		return fmt.Errorf("AllocateUserToDrive: upsert: %w", err)
	}
	return tx.Commit()
}

// AddUserDrive grants a user an additional (non-primary) drive allocation,
// leaving the existing primary intact. No-op on conflict.
func (q *Queries) AddUserDrive(ctx context.Context, username string, driveID uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO user_drive_allocations (user_id, drive_id, is_primary)
		VALUES ($1, $2, false)
		ON CONFLICT (user_id, drive_id) DO NOTHING
	`, username, driveID)
	if err != nil {
		return fmt.Errorf("AddUserDrive: %w", err)
	}
	return nil
}

// SetPrimaryDrive makes driveID the user's primary, but only if the user is
// already allocated to it. Returns sql.ErrNoRows when they are not.
func (q *Queries) SetPrimaryDrive(ctx context.Context, username string, driveID uuid.UUID) error {
	tx, err := q.pool.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("SetPrimaryDrive: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var exists bool
	if err := tx.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM user_drive_allocations WHERE user_id = $1 AND drive_id = $2)`,
		username, driveID,
	).Scan(&exists); err != nil {
		return fmt.Errorf("SetPrimaryDrive: check: %w", err)
	}
	if !exists {
		return sql.ErrNoRows
	}

	if _, err := tx.ExecContext(ctx,
		`UPDATE user_drive_allocations SET is_primary = (drive_id = $2) WHERE user_id = $1`,
		username, driveID,
	); err != nil {
		return fmt.Errorf("SetPrimaryDrive: update: %w", err)
	}
	return tx.Commit()
}

// GetDriveSummaries returns per-drive usage stats for the infrastructure view.
func (q *Queries) GetDriveSummaries(ctx context.Context) ([]models.DriveSummary, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT
			d.id, d.server_id, s.name,
			d.node_id, COALESCE(n.hostname, ''), COALESCE(n.role, ''), COALESCE(n.is_active, false),
			d.label,
			d.drive_type,
			d.capacity_bytes, d.minio_bucket,
			COALESCE(SUM(u.storage_quota_bytes), 0) AS allocated_quota_bytes,
			COALESCE(SUM(u.storage_used_bytes), 0)  AS used_bytes,
			d.is_active, s.is_active
		FROM drives d
		JOIN servers s ON s.id = d.server_id
		LEFT JOIN nodes n ON n.id = d.node_id
		LEFT JOIN user_drive_allocations uda ON uda.drive_id = d.id
		LEFT JOIN users u ON u.username = uda.user_id
		GROUP BY d.id, s.id, n.id
		ORDER BY s.name ASC, n.hostname ASC, d.label ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("GetDriveSummaries: %w", err)
	}
	defer rows.Close()

	var out []models.DriveSummary
	for rows.Next() {
		var ds models.DriveSummary
		if err := rows.Scan(
			&ds.DriveID, &ds.ServerID, &ds.ServerName,
			&ds.NodeID, &ds.NodeHostname, &ds.NodeRole, &ds.NodeIsActive,
			&ds.DriveLabel, &ds.DriveType,
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
