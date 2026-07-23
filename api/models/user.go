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
	// PremiumExpiresAt is an admin-granted Premium "trial" expiry — independent
	// of real PayPal billing. Nil means either not premium, or premium granted
	// with no expiry (permanent). Set via the admin Users page's role editor;
	// swept by PaymentService.ExpireAdminGrantedPremium once it lapses.
	PremiumExpiresAt *time.Time `json:"premium_expires_at" db:"premium_expires_at"`
	// PremiumPurchaseBlocked, when true, prevents the user from starting a new
	// Premium subscription (payments.Handler.CreateSubscription). Set by the
	// admin Users page's role editor when demoting an active Premium user.
	PremiumPurchaseBlocked bool `json:"premium_purchase_blocked" db:"premium_purchase_blocked"`
	// FeedbackAccessEnabled gates submission of the profile-page feedback form.
	// Disabled by default; admins grant it per-user from the admin Feedback →
	// Access tab.
	FeedbackAccessEnabled bool `json:"feedback_access_enabled" db:"feedback_access_enabled"`
	// ActiveBan is populated by the admin ListUsers query via a lateral join.
	// It is nil when the user has no active ban or suspension.
	ActiveBan *UserBan `json:"active_ban,omitempty"`
	// PremiumSubscribed is true when the user has an active or suspended
	// premium_subscriptions row of their own — as opposed to IsPremium, which
	// is also true for every admin regardless of whether they ever subscribed
	// (see middleware.RequireAuth's isAdmin-implies-isPremium override).
	// Populated by ListUsers (lateral join) and Me (dedicated query);
	// zero-value false everywhere else.
	PremiumSubscribed bool `json:"premium_subscribed"`
}
