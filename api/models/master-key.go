package models

import "time"

type MasterKeyStatus string

const (
	MasterKeyStatusActive   MasterKeyStatus = "active"
	MasterKeyStatusRetiring MasterKeyStatus = "retiring"
	MasterKeyStatusDeleted  MasterKeyStatus = "deleted"
)

type KeyRotationStatus string

const (
	KeyRotationStatusCompleted KeyRotationStatus = "completed"
	KeyRotationStatusFailed    KeyRotationStatus = "failed"
)

// MasterKey mirrors the `master_keys` table. The id is a human-readable
// version string (e.g. "v1", "v2") rather than a UUID.
// encrypted_key_material and key_nonce are NULL once the key has been deleted;
// only the metadata row is retained for audit purposes.
type MasterKey struct {
	ID                   string          `json:"id" db:"id"`
	EncryptedKeyMaterial []byte          `json:"-" db:"encrypted_key_material"`
	KeyNonce             []byte          `json:"-" db:"key_nonce"`
	Status               MasterKeyStatus `json:"status" db:"status"`
	CreatedAt            time.Time       `json:"created_at" db:"created_at"`
	RetiredAt            *time.Time      `json:"retired_at" db:"retired_at"`
	DeletedAt            *time.Time      `json:"deleted_at" db:"deleted_at"`
}

// KeyRotationLog mirrors the `key_rotation_log` table.
// completed_at is NULL when rotation failed mid-way.
type KeyRotationLog struct {
	ID             string            `json:"id" db:"id"`
	OldKeyVersion  string            `json:"old_key_version" db:"old_key_version"`
	NewKeyVersion  string            `json:"new_key_version" db:"new_key_version"`
	UsersRewrapped int               `json:"users_rewrapped" db:"users_rewrapped"`
	StartedAt      time.Time         `json:"started_at" db:"started_at"`
	CompletedAt    *time.Time        `json:"completed_at" db:"completed_at"`
	Status         KeyRotationStatus `json:"status" db:"status"`
	Error          *string           `json:"error,omitempty" db:"error"`
}
