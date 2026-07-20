package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type AuditLog struct {
	ID             uuid.UUID  `json:"id"`
	TargetUsername string     `json:"target_username"`
	ActorUsername  string     `json:"actor_username"`
	Action         string     `json:"action"`
	ResourceType   *string    `json:"resource_type,omitempty"`
	ResourceID     *uuid.UUID `json:"resource_id,omitempty"`
	ResourceName   *string    `json:"resource_name,omitempty"`
	// Details is a generic, action-specific structured payload (e.g. the
	// storage allocation editor's before/after breakdown + reason — see
	// StorageAllocationChangeDetails). Raw passthrough since audit_logs
	// covers many action types; nil for every action that predates it.
	Details   json.RawMessage `json:"details,omitempty"`
	CreatedAt time.Time       `json:"created_at"`
}
