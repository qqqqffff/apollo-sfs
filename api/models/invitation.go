package models

import (
	"time"

	"github.com/google/uuid"
)

// Invitation mirrors the `invitations` table. Only admin-role users can create
// rows (enforced by the admin middleware on the route).
// Unique constraint: email where accepted_at IS NULL and revoked_at IS NULL —
// prevents duplicate pending invites to the same address.
type Invitation struct {
	ID                uuid.UUID  `json:"id" db:"id"`
	InvitedByUserID   uuid.UUID  `json:"invited_by_user_id" db:"invited_by_user_id"`
	Email             string     `json:"email" db:"email"`
	Token             string     `json:"-" db:"token"` // never expose the raw token in API responses
	TokenExpiresAt    time.Time  `json:"token_expires_at" db:"token_expires_at"`
	AcceptedAt        *time.Time `json:"accepted_at" db:"accepted_at"`
	RevokedAt         *time.Time `json:"revoked_at" db:"revoked_at"`
	CreatedAt         time.Time  `json:"created_at" db:"created_at"`
	InitialQuotaBytes int64      `json:"initial_quota_bytes" db:"initial_quota_bytes"`
	GrantAdmin        bool       `json:"grant_admin" db:"grant_admin"`
	GrantPremium      bool       `json:"grant_premium" db:"grant_premium"`
}
