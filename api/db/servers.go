package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

const serverColumns = `
	id, name, state, minio_endpoint, minio_use_ssl,
	minio_access_key_enc, minio_access_key_nonce,
	minio_secret_key_enc, minio_secret_key_nonce,
	is_active, created_at`

func scanServer(row *sql.Row) (*models.Server, error) {
	var s models.Server
	err := row.Scan(
		&s.ID, &s.Name, &s.State, &s.MinioEndpoint, &s.MinioUseSSL,
		&s.MinioAccessKeyEnc, &s.MinioAccessKeyNonce,
		&s.MinioSecretKeyEnc, &s.MinioSecretKeyNonce,
		&s.IsActive, &s.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func scanServerRow(rows *sql.Rows) (*models.Server, error) {
	var s models.Server
	err := rows.Scan(
		&s.ID, &s.Name, &s.State, &s.MinioEndpoint, &s.MinioUseSSL,
		&s.MinioAccessKeyEnc, &s.MinioAccessKeyNonce,
		&s.MinioSecretKeyEnc, &s.MinioSecretKeyNonce,
		&s.IsActive, &s.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// ListServers returns all server rows ordered by created_at ASC.
func (q *Queries) ListServers(ctx context.Context) ([]models.Server, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT`+serverColumns+`
		FROM servers
		ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("ListServers: %w", err)
	}
	defer rows.Close()

	var out []models.Server
	for rows.Next() {
		s, err := scanServerRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListServers scan: %w", err)
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

// GetServer fetches a single server by ID.
func (q *Queries) GetServer(ctx context.Context, id uuid.UUID) (*models.Server, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT`+serverColumns+`
		FROM servers WHERE id = $1
	`, id)
	s, err := scanServer(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetServer: %w", err)
	}
	return s, nil
}

// CountServersByState returns how many servers share the given state code.
// Used to generate the next sequential name (e.g. "NH-0002").
func (q *Queries) CountServersByState(ctx context.Context, state string) (int, error) {
	var n int
	err := q.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM servers WHERE state = $1`, state,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("CountServersByState: %w", err)
	}
	return n, nil
}

// CreateServerParams carries all fields needed to insert a new server row.
type CreateServerParams struct {
	Name                string
	State               string
	MinioEndpoint       string
	MinioUseSSL         bool
	MinioAccessKeyEnc   []byte
	MinioAccessKeyNonce []byte
	MinioSecretKeyEnc   []byte
	MinioSecretKeyNonce []byte
}

// CreateServer inserts a new server and returns the created row.
func (q *Queries) CreateServer(ctx context.Context, p CreateServerParams) (*models.Server, error) {
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO servers
			(name, state, minio_endpoint, minio_use_ssl,
			 minio_access_key_enc, minio_access_key_nonce,
			 minio_secret_key_enc, minio_secret_key_nonce)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING`+serverColumns,
		p.Name, p.State, p.MinioEndpoint, p.MinioUseSSL,
		p.MinioAccessKeyEnc, p.MinioAccessKeyNonce,
		p.MinioSecretKeyEnc, p.MinioSecretKeyNonce,
	)
	s, err := scanServer(row)
	if err != nil {
		return nil, fmt.Errorf("CreateServer: %w", err)
	}
	return s, nil
}

// ServerCapacity holds aggregated capacity info for a single active server.
type ServerCapacity struct {
	ServerID           uuid.UUID
	Name               string
	State              string
	TotalCapacityBytes int64
	AvailableBytes     int64
	// DriveType is "nvme" if any active drive label contains "nvme" (case-insensitive), otherwise "hdd".
	DriveType string
}

// ListServerCapacities returns capacity aggregated across active drives for
// every active server, ordered by name.
func (q *Queries) ListServerCapacities(ctx context.Context) ([]ServerCapacity, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT
			s.id, s.name, s.state,
			COALESCE(SUM(d.capacity_bytes), 0)                                     AS total_capacity_bytes,
			COALESCE(SUM(GREATEST(d.capacity_bytes - COALESCE(sub.allocated, 0), 0)), 0) AS available_bytes,
			CASE WHEN COALESCE(BOOL_OR(d.drive_type = 'nvme'), false) THEN 'nvme' ELSE 'hdd' END AS drive_type
		FROM servers s
		LEFT JOIN drives d ON d.server_id = s.id AND d.is_active = true
		LEFT JOIN (
			SELECT uda.drive_id, SUM(u.storage_quota_bytes) AS allocated
			FROM user_drive_allocations uda
			JOIN users u ON u.username = uda.user_id
			GROUP BY uda.drive_id
		) sub ON sub.drive_id = d.id
		WHERE s.is_active = true
		GROUP BY s.id
		ORDER BY s.name ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("ListServerCapacities: %w", err)
	}
	defer rows.Close()

	var out []ServerCapacity
	for rows.Next() {
		var sc ServerCapacity
		if err := rows.Scan(&sc.ServerID, &sc.Name, &sc.State,
			&sc.TotalCapacityBytes, &sc.AvailableBytes, &sc.DriveType); err != nil {
			return nil, fmt.Errorf("ListServerCapacities scan: %w", err)
		}
		out = append(out, sc)
	}
	return out, rows.Err()
}

// GetServerCapacity returns aggregated capacity info for a single active
// server, or nil when the server does not exist or is inactive. Backs the
// 90%-allocation purchase gate in the billing handler.
func (q *Queries) GetServerCapacity(ctx context.Context, serverID uuid.UUID) (*ServerCapacity, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT
			s.id, s.name, s.state,
			COALESCE(SUM(d.capacity_bytes), 0)                                     AS total_capacity_bytes,
			COALESCE(SUM(GREATEST(d.capacity_bytes - COALESCE(sub.allocated, 0), 0)), 0) AS available_bytes,
			CASE WHEN COALESCE(BOOL_OR(d.drive_type = 'nvme'), false) THEN 'nvme' ELSE 'hdd' END AS drive_type
		FROM servers s
		LEFT JOIN drives d ON d.server_id = s.id AND d.is_active = true
		LEFT JOIN (
			SELECT uda.drive_id, SUM(u.storage_quota_bytes) AS allocated
			FROM user_drive_allocations uda
			JOIN users u ON u.username = uda.user_id
			GROUP BY uda.drive_id
		) sub ON sub.drive_id = d.id
		WHERE s.is_active = true AND s.id = $1
		GROUP BY s.id
	`, serverID)
	var sc ServerCapacity
	if err := row.Scan(&sc.ServerID, &sc.Name, &sc.State,
		&sc.TotalCapacityBytes, &sc.AvailableBytes, &sc.DriveType); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("GetServerCapacity: %w", err)
	}
	return &sc, nil
}

// GetServerByEndpoint fetches a server by its MinIO endpoint. Returns nil if no
// server is registered for that endpoint. Used by the infrastructure sync to
// upsert servers keyed by their MinIO endpoint.
func (q *Queries) GetServerByEndpoint(ctx context.Context, endpoint string) (*models.Server, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT`+serverColumns+`
		FROM servers WHERE minio_endpoint = $1
	`, endpoint)
	s, err := scanServer(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetServerByEndpoint: %w", err)
	}
	return s, nil
}

// SetServerActive toggles a server's is_active flag.
func (q *Queries) SetServerActive(ctx context.Context, id uuid.UUID, active bool) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE servers SET is_active = $2 WHERE id = $1`, id, active)
	if err != nil {
		return fmt.Errorf("SetServerActive: %w", err)
	}
	return nil
}

// RenameServer updates the display name of a server.
func (q *Queries) RenameServer(ctx context.Context, id uuid.UUID, name string) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE servers SET name = $2 WHERE id = $1`, id, name)
	if err != nil {
		return fmt.Errorf("RenameServer: %w", err)
	}
	return nil
}

// DeleteServer removes a server row. Its nodes (and their node_disks) cascade via
// the FK; drives FK-restrict, so the caller must first reassign or remove every
// drive of the server. Used by the sync to retire stale per-tier servers once the
// cluster has been collapsed onto a single server.
func (q *Queries) DeleteServer(ctx context.Context, id uuid.UUID) error {
	if _, err := q.db.ExecContext(ctx, `DELETE FROM servers WHERE id = $1`, id); err != nil {
		return fmt.Errorf("DeleteServer: %w", err)
	}
	return nil
}
