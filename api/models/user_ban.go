package models

import "time"

// UserBan represents a ban or suspension record for a user.
type UserBan struct {
	ID            int64      `json:"id"`
	Username      string     `json:"username"`
	BanType       string     `json:"ban_type"`       // "banned" | "suspended"
	ViolationCode string     `json:"violation_code"` // TOS section code
	Comments      string     `json:"comments"`
	BannedBy      string     `json:"banned_by"`
	BannedAt      time.Time  `json:"banned_at"`
	ExpiresAt     *time.Time `json:"expires_at"`  // nil = permanent
	PardonedAt    *time.Time `json:"pardoned_at"` // nil = still active
	PardonedBy    *string    `json:"pardoned_by"`
}
