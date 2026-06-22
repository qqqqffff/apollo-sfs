package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// ── Nodes ──────────────────────────────────────────────────────────────────────

const nodeColumns = `
	id, server_id, hostname, role, address, is_active, created_at`

func scanNode(row *sql.Row) (*models.Node, error) {
	var n models.Node
	err := row.Scan(&n.ID, &n.ServerID, &n.Hostname, &n.Role,
		&n.Address, &n.IsActive, &n.CreatedAt)
	if err != nil {
		return nil, err
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
type CreateNodeParams struct {
	ServerID uuid.UUID
	Hostname string
	Role     string
	Address  string
}

// CreateNode inserts a new node and returns the created row.
func (q *Queries) CreateNode(ctx context.Context, p CreateNodeParams) (*models.Node, error) {
	role := p.Role
	if role == "" {
		role = "worker"
	}
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO nodes (server_id, hostname, role, address)
		VALUES ($1, $2, $3, $4)
		RETURNING`+nodeColumns,
		p.ServerID, p.Hostname, role, p.Address,
	)
	n, err := scanNode(row)
	if err != nil {
		return nil, fmt.Errorf("CreateNode: %w", err)
	}
	return n, nil
}

// UpdateNodeParams carries updateable fields for a node.
type UpdateNodeParams struct {
	Hostname string
	Role     string
	Address  string
	IsActive bool
}

// UpdateNode updates the mutable fields of a node and returns the updated row.
func (q *Queries) UpdateNode(ctx context.Context, id uuid.UUID, p UpdateNodeParams) (*models.Node, error) {
	row := q.db.QueryRowContext(ctx, `
		UPDATE nodes SET hostname = $2, role = $3, address = $4, is_active = $5
		WHERE id = $1
		RETURNING`+nodeColumns,
		id, p.Hostname, p.Role, p.Address, p.IsActive,
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
