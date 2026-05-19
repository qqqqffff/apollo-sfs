package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// AuditInput holds the fields written to audit_logs for a single event.
type AuditInput struct {
	TargetUsername string
	ActorUsername  string
	Action         string
	ResourceType   *string
	ResourceID     *uuid.UUID
	ResourceName   *string
}

// InsertAuditLog writes one audit record. Errors are logged by the caller.
func (q *Queries) InsertAuditLog(ctx context.Context, in AuditInput) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO audit_logs (target_username, actor_username, action, resource_type, resource_id, resource_name)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, in.TargetUsername, in.ActorUsername, in.Action, in.ResourceType, in.ResourceID, in.ResourceName)
	if err != nil {
		return fmt.Errorf("InsertAuditLog: %w", err)
	}
	return nil
}

// ListAuditLogsForUser returns a paginated list of audit events for a user,
// ordered newest-first.
func (q *Queries) ListAuditLogsForUser(ctx context.Context, username string, in PageInput) (*PageResult[models.AuditLog], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListAuditLogsForUser: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, `
		SELECT id, target_username, actor_username, action, resource_type, resource_id, resource_name, created_at
		FROM audit_logs
		WHERE target_username = $1
		ORDER BY created_at DESC
		LIMIT $2 OFFSET $3
	`, username, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("ListAuditLogsForUser: %w", err)
	}
	defer rows.Close()

	var logs []models.AuditLog
	for rows.Next() {
		var l models.AuditLog
		var resourceType sql.NullString
		var resourceID uuid.NullUUID
		var resourceName sql.NullString
		if err := rows.Scan(
			&l.ID, &l.TargetUsername, &l.ActorUsername, &l.Action,
			&resourceType, &resourceID, &resourceName, &l.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("ListAuditLogsForUser scan: %w", err)
		}
		if resourceType.Valid {
			l.ResourceType = &resourceType.String
		}
		if resourceID.Valid {
			l.ResourceID = &resourceID.UUID
		}
		if resourceName.Valid {
			l.ResourceName = &resourceName.String
		}
		logs = append(logs, l)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListAuditLogsForUser: %w", err)
	}
	if logs == nil {
		logs = []models.AuditLog{}
	}
	return &PageResult[models.AuditLog]{
		Items:     logs,
		NextToken: offsetNextToken(len(logs), limit, offset),
	}, nil
}
