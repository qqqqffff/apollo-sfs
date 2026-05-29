package models

import (
	"time"

	"github.com/google/uuid"
)

// Server represents a physical machine running a MinIO instance.
// MinIO credentials are stored encrypted; never exposed in JSON responses.
type Server struct {
	ID                  uuid.UUID `json:"id"`
	Name                string    `json:"name"`
	State               string    `json:"state"`
	MinioEndpoint       string    `json:"minio_endpoint"`
	MinioUseSSL         bool      `json:"minio_use_ssl"`
	MinioAccessKeyEnc   []byte    `json:"-"`
	MinioAccessKeyNonce []byte    `json:"-"`
	MinioSecretKeyEnc   []byte    `json:"-"`
	MinioSecretKeyNonce []byte    `json:"-"`
	IsActive            bool      `json:"is_active"`
	CreatedAt           time.Time `json:"created_at"`
}

// Drive represents a physical drive on a Server. All files for a user are
// stored in a single drive's MinIO bucket; users are never split across drives.
type Drive struct {
	ID            uuid.UUID `json:"id"`
	ServerID      uuid.UUID `json:"server_id"`
	Label         string    `json:"label"`
	CapacityBytes int64     `json:"capacity_bytes"`
	MinioBucket   string    `json:"minio_bucket"`
	IsActive      bool      `json:"is_active"`
	CreatedAt     time.Time `json:"created_at"`
}

// UserDriveAllocation records which drive a user's quota and files live on.
type UserDriveAllocation struct {
	UserID      string    `json:"user_id"`
	DriveID     uuid.UUID `json:"drive_id"`
	AllocatedAt time.Time `json:"allocated_at"`

	// Populated by GetUserDrive — not stored directly in the table.
	Drive  Drive  `json:"drive"`
	Server Server `json:"server"`
}

// DriveSummary is returned by GetDriveSummaries for the infrastructure view.
// AllocatedQuotaBytes is the sum of storage_quota_bytes for all users on this drive.
// UsedBytes is the sum of storage_used_bytes for all users on this drive.
type DriveSummary struct {
	DriveID              uuid.UUID `json:"drive_id"`
	ServerID             uuid.UUID `json:"server_id"`
	ServerName           string    `json:"server_name"`
	DriveLabel           string    `json:"drive_label"`
	CapacityBytes        int64     `json:"capacity_bytes"`
	MinioBucket          string    `json:"minio_bucket"`
	AllocatedQuotaBytes  int64     `json:"allocated_quota_bytes"`
	UsedBytes            int64     `json:"used_bytes"`
	DriveIsActive        bool      `json:"drive_is_active"`
	ServerIsActive       bool      `json:"server_is_active"`
}

// ServerWithDrives is the response shape for the infrastructure listing.
type ServerWithDrives struct {
	Server
	Drives []DriveSummary `json:"drives"`
}
