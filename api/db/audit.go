package db

import (
	"context"
	"database/sql"
	"encoding/json"
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
	// Details is a generic, action-specific structured payload (e.g. the
	// storage allocation editor's before/after breakdown + reason). Nil for
	// every action that doesn't need more than the flat fields above.
	Details json.RawMessage
}

// InsertAuditLog writes one audit record. Errors are logged by the caller.
func (q *Queries) InsertAuditLog(ctx context.Context, in AuditInput) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO audit_logs (target_username, actor_username, action, resource_type, resource_id, resource_name, details)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, in.TargetUsername, in.ActorUsername, in.Action, in.ResourceType, in.ResourceID, in.ResourceName, nullableJSON(in.Details))
	if err != nil {
		return fmt.Errorf("InsertAuditLog: %w", err)
	}
	return nil
}

// nullableJSON turns an empty/nil json.RawMessage into a real SQL NULL rather
// than the literal 4-byte JSON string "null", so audit_logs.details stays
// unset (not a JSON null) for actions that don't populate it.
func nullableJSON(b json.RawMessage) any {
	if len(b) == 0 {
		return nil
	}
	return []byte(b)
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
		SELECT id, target_username, actor_username, action, resource_type, resource_id, resource_name, details, created_at
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
		var details []byte
		if err := rows.Scan(
			&l.ID, &l.TargetUsername, &l.ActorUsername, &l.Action,
			&resourceType, &resourceID, &resourceName, &details, &l.CreatedAt,
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
		if len(details) > 0 {
			l.Details = details
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
