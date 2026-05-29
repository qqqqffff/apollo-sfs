package models

import (
	"time"

	"github.com/google/uuid"
)

// APIKey mirrors the api_keys table. Used by the SFS S3-like API for
// programmatic access by premium users. The raw secret is shown only once
// at issuance; KeyHash stores the argon2id digest of the secret half.
type APIKey struct {
	ID         uuid.UUID  `json:"id"           db:"id"`
	Username   string     `json:"username"     db:"username"`
	Name       string     `json:"name"         db:"name"`
	KeyPrefix  string     `json:"key_prefix"   db:"key_prefix"`
	KeyHash    string     `json:"-"            db:"key_hash"`
	CreatedAt  time.Time  `json:"created_at"   db:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at" db:"last_used_at"`
	ExpiresAt  *time.Time `json:"expires_at"   db:"expires_at"`
	RevokedAt  *time.Time `json:"revoked_at"   db:"revoked_at"`

	// Scopes is populated by ListAPIKeys / GetAPIKey when requested.
	Scopes []APIKeyScope `json:"scopes,omitempty"`
}

// APIKeyScope is a single (operation, path_prefix) tuple granting permission
// for one CRUD-style operation against a path prefix in the user's namespace.
// Operation is one of "read", "write", "delete", "list".
type APIKeyScope struct {
	ID         uuid.UUID `json:"id,omitempty" db:"id"`
	APIKeyID   uuid.UUID `json:"-"             db:"api_key_id"`
	Operation  string    `json:"operation"     db:"operation"`
	PathPrefix string    `json:"path_prefix"   db:"path_prefix"`
}
