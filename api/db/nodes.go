package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"
	"github.com/lib/pq"

	"apollo-sfs.com/api/models"
)

// ── Nodes ──────────────────────────────────────────────────────────────────────

const nodeColumns = `
	id, server_id, hostname, role, address, minio_endpoint, minio_use_ssl, is_active, created_at`

func scanNode(row *sql.Row) (*models.Node, error) {
	var n models.Node
	var endpoint sql.NullString
	err := row.Scan(&n.ID, &n.ServerID, &n.Hostname, &n.Role,
		&n.Address, &endpoint, &n.MinioUseSSL, &n.IsActive, &n.CreatedAt)
	if err != nil {
		return nil, err
	}
	if endpoint.Valid && endpoint.String != "" {
		n.MinioEndpoint = &endpoint.String
	}
	return &n, nil
}

// GetNode fetches a single node by ID. Returns nil if not found.
func (q *Queries) GetNode(ctx context.Context, id uuid.UUID) (*models.Node, error) {
	row := q.db.QueryRowContext(ctx,
		`SELECT`+nodeColumns+` FROM nodes WHERE id = $1`, id)
	n, err := scanNode(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetNode: %w", err)
	}
	return n, nil
}

// CreateNodeParams carries the fields needed to insert a new node row.
// MinioEndpoint is optional — nil leaves the node inheriting its server's endpoint.
type CreateNodeParams struct {
	ServerID      uuid.UUID
	Hostname      string
	Role          string
	Address       string
	MinioEndpoint *string
	MinioUseSSL   bool
}

// CreateNode inserts a new node and returns the created row.
func (q *Queries) CreateNode(ctx context.Context, p CreateNodeParams) (*models.Node, error) {
	role := p.Role
	if role == "" {
		role = "worker"
	}
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO nodes (server_id, hostname, role, address, minio_endpoint, minio_use_ssl)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING`+nodeColumns,
		p.ServerID, p.Hostname, role, p.Address, p.MinioEndpoint, p.MinioUseSSL,
	)
	n, err := scanNode(row)
	if err != nil {
		return nil, fmt.Errorf("CreateNode: %w", err)
	}
	return n, nil
}

// UpdateNodeParams carries updateable fields for a node.
type UpdateNodeParams struct {
	Hostname      string
	Role          string
	Address       string
	MinioEndpoint *string
	MinioUseSSL   bool
	IsActive      bool
}

// UpdateNode updates the mutable fields of a node and returns the updated row.
func (q *Queries) UpdateNode(ctx context.Context, id uuid.UUID, p UpdateNodeParams) (*models.Node, error) {
	row := q.db.QueryRowContext(ctx, `
		UPDATE nodes
		SET hostname = $2, role = $3, address = $4,
		    minio_endpoint = $5, minio_use_ssl = $6, is_active = $7
		WHERE id = $1
		RETURNING`+nodeColumns,
		id, p.Hostname, p.Role, p.Address, p.MinioEndpoint, p.MinioUseSSL, p.IsActive,
	)
	n, err := scanNode(row)
	if err != nil {
		return nil, fmt.Errorf("UpdateNode: %w", err)
	}
	return n, nil
}

// DeleteNode removes a node. Drives mounted on it are detached (node_id set NULL)
// by the ON DELETE SET NULL foreign key, so no data is lost.
func (q *Queries) DeleteNode(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `DELETE FROM nodes WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("DeleteNode: %w", err)
	}
	return nil
}

// AssignDriveToNode sets (or clears, when nodeID is nil) the node a drive is
// mounted on. The caller is responsible for ensuring the node belongs to the
// same server as the drive.
func (q *Queries) AssignDriveToNode(ctx context.Context, driveID uuid.UUID, nodeID *uuid.UUID) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE drives SET node_id = $2 WHERE id = $1`, driveID, nodeID)
	if err != nil {
		return fmt.Errorf("AssignDriveToNode: %w", err)
	}
	return nil
}

// UpsertNode inserts a node, or updates its role/address/active flag when one
// already exists for (server_id, hostname). Returns the resulting row. Used by
// the infrastructure sync to reconcile discovered swarm nodes idempotently.
func (q *Queries) UpsertNode(ctx context.Context, p CreateNodeParams, isActive bool) (*models.Node, error) {
	role := p.Role
	if role == "" {
		role = "worker"
	}
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO nodes (server_id, hostname, role, address, minio_endpoint, minio_use_ssl, is_active)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (server_id, hostname)
		DO UPDATE SET
			role           = EXCLUDED.role,
			address        = EXCLUDED.address,
			minio_endpoint = EXCLUDED.minio_endpoint,
			minio_use_ssl  = EXCLUDED.minio_use_ssl,
			is_active      = EXCLUDED.is_active
		RETURNING`+nodeColumns,
		p.ServerID, p.Hostname, role, p.Address, p.MinioEndpoint, p.MinioUseSSL, isActive,
	)
	n, err := scanNode(row)
	if err != nil {
		return nil, fmt.Errorf("UpsertNode: %w", err)
	}
	return n, nil
}

// DeactivateMissingNodes marks every node of a server inactive except those whose
// ID is in keepIDs. Used by the sync to retire nodes that have left the swarm
// without deleting them (drives stay attached). A nil/empty keepIDs deactivates
// all of the server's nodes.
func (q *Queries) DeactivateMissingNodes(ctx context.Context, serverID uuid.UUID, keepIDs []uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE nodes SET is_active = false
		WHERE server_id = $1 AND is_active = true AND NOT (id = ANY($2::uuid[]))
	`, serverID, pq.Array(keepIDs))
	if err != nil {
		return fmt.Errorf("DeactivateMissingNodes: %w", err)
	}
	return nil
}

// ListActiveNodesWithMinIO returns every active node that carries its own MinIO
// endpoint, joined to the parent server so the registry can build a client using
// the server's (inherited) credentials. Used at startup to seed node-level
// MinIO clients.
func (q *Queries) ListActiveNodesWithMinIO(ctx context.Context) ([]models.Node, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT`+nodeColumns+`
		FROM nodes
		WHERE is_active = true AND minio_endpoint IS NOT NULL AND minio_endpoint <> ''
		ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("ListActiveNodesWithMinIO: %w", err)
	}
	defer rows.Close()

	var out []models.Node
	for rows.Next() {
		var n models.Node
		var endpoint sql.NullString
		if err := rows.Scan(&n.ID, &n.ServerID, &n.Hostname, &n.Role,
			&n.Address, &endpoint, &n.MinioUseSSL, &n.IsActive, &n.CreatedAt); err != nil {
			return nil, fmt.Errorf("ListActiveNodesWithMinIO scan: %w", err)
		}
		if endpoint.Valid && endpoint.String != "" {
			n.MinioEndpoint = &endpoint.String
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// GetNodeSummaries returns every node with its parent server's display fields,
// ordered for the infrastructure view. Nodes with no drives are included so the
// metrics page can render empty nodes.
func (q *Queries) GetNodeSummaries(ctx context.Context) ([]models.NodeSummary, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT
			n.id, n.server_id, s.name, s.state, s.is_active,
			n.hostname, n.role, n.address, n.is_active, n.created_at
		FROM nodes n
		JOIN servers s ON s.id = n.server_id
		ORDER BY s.name ASC, n.hostname ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("GetNodeSummaries: %w", err)
	}
	defer rows.Close()

	var out []models.NodeSummary
	for rows.Next() {
		var ns models.NodeSummary
		if err := rows.Scan(
			&ns.NodeID, &ns.ServerID, &ns.ServerName, &ns.ServerState, &ns.ServerIsActive,
			&ns.Hostname, &ns.Role, &ns.Address, &ns.IsActive, &ns.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("GetNodeSummaries scan: %w", err)
		}
		out = append(out, ns)
	}
	return out, rows.Err()
}
