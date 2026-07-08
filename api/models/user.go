package models

import (
	"time"
)

// User mirrors the `users` table. The username matches the Keycloak subject claim.
type User struct {
	Username          string     `json:"username" db:"username"`
	Email             string     `json:"email" db:"email"`
	EncryptedKey      []byte     `json:"-" db:"encrypted_key"`
	KeyNonce          []byte     `json:"-" db:"key_nonce"`
	MasterKeyVersion  string     `json:"-" db:"master_key_version"`
	StorageUsedBytes  int64      `json:"storage_used_bytes" db:"storage_used_bytes"`
	StorageQuotaBytes int64      `json:"storage_quota_bytes" db:"storage_quota_bytes"`
	LastSeenAt        *time.Time `json:"last_seen_at" db:"last_seen_at"`
	CreatedAt         time.Time  `json:"created_at" db:"created_at"`
	IsAdmin           bool       `json:"is_admin" db:"is_admin"`
	IsPremium         bool       `json:"is_premium" db:"is_premium"`
	PremiumGrantedAt  *time.Time `json:"premium_granted_at" db:"premium_granted_at"`
	// ActiveBan is populated by the admin ListUsers query via a lateral join.
	// It is nil when the user has no active ban or suspension.
	ActiveBan *UserBan `json:"active_ban,omitempty"`
	// PremiumPurchased is true when the user has an active (captured, not
	// refunded or allocation-reverted) premium payment of their own — as
	// opposed to IsPremium, which is also true for every admin regardless of
	// whether they ever paid (see middleware.RequireAuth's isAdmin-implies-
	// isPremium override). Populated by ListUsers (lateral join) and Me
	// (dedicated query); zero-value false everywhere else.
	PremiumPurchased bool `json:"premium_purchased"`
}
