package models

import (
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
	CreatedAt      time.Time  `json:"created_at"`
}
