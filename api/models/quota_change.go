package models

import "github.com/google/uuid"

// QuotaAllocationSnapshot is one drive's allocation state captured in a
// StorageAllocationChangeDetails before/after snapshot.
type QuotaAllocationSnapshot struct {
	DriveID    uuid.UUID `json:"drive_id"`
	ServerName string    `json:"server_name"`
	DriveType  string    `json:"drive_type"` // "nvme" | "hdd"
	QuotaBytes int64     `json:"quota_bytes"`
}

// StorageAllocationChangeDetails is the structured before/after breakdown
// stored byte-identical in both audit_logs.details and
// quota_change_notifications.details for a "storage_allocations_updated"
// event, so the admin audit log and the affected user's notification-bell
// "Breakdown" button render the exact same detail.
type StorageAllocationChangeDetails struct {
	Reason *string                   `json:"reason,omitempty"`
	Before []QuotaAllocationSnapshot `json:"before"`
	After  []QuotaAllocationSnapshot `json:"after"`
}
