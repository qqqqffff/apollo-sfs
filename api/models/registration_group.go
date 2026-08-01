package models

import (
	"time"

	"github.com/google/uuid"
)

// RegistrationGroup mirrors the `registration_groups` table: an admin-created
// bundle of preconfigured account slots that end users claim from the public
// /group-invite?id=<link_id> page. Only admin-role users can create rows
// (enforced by the admin middleware on the route).
type RegistrationGroup struct {
	ID                 uuid.UUID  `json:"id" db:"id"`
	CreatedByUserID    uuid.UUID  `json:"created_by_user_id" db:"created_by_user_id"`
	Name               string     `json:"name" db:"name"`
	LinkID             string     `json:"link_id" db:"link_id"`
	ExpiresAt          *time.Time `json:"expires_at" db:"expires_at"`
	IsActive           bool       `json:"is_active" db:"is_active"`
	NotifyEmails       []string   `json:"notify_emails" db:"notify_emails"`
	SendExpiryReminder bool       `json:"send_expiry_reminder" db:"send_expiry_reminder"`
	ReminderSentAt     *time.Time `json:"reminder_sent_at" db:"reminder_sent_at"`
	CreatedAt          time.Time  `json:"created_at" db:"created_at"`
}

// RegistrationSlot mirrors the `registration_slots` table: one registerable
// account. DriveType is "nvme" (fast) or "hdd" (standard); AccountStatus is
// "base" or "premium" (admin accounts cannot be provisioned via a group).
type RegistrationSlot struct {
	ID               uuid.UUID  `json:"id" db:"id"`
	GroupID          uuid.UUID  `json:"group_id" db:"group_id"`
	ServerID         uuid.UUID  `json:"server_id" db:"server_id"`
	DriveID          uuid.UUID  `json:"drive_id" db:"drive_id"`
	DriveType        string     `json:"drive_type" db:"drive_type"`
	QuotaBytes       int64      `json:"quota_bytes" db:"quota_bytes"`
	AccountStatus    string     `json:"account_status" db:"account_status"`
	PremiumExpiresAt *time.Time `json:"premium_expires_at" db:"premium_expires_at"`
	ConsumedAt       *time.Time `json:"consumed_at" db:"consumed_at"`
	ConsumedBy       *string    `json:"consumed_by" db:"consumed_by"`
	CreatedAt        time.Time  `json:"created_at" db:"created_at"`
}

// RegistrationSlotReservation mirrors the `registration_slot_reservations`
// table: a short-lived hold on one slot while a user fills out the
// registration form. The raw token is never exposed in admin responses.
type RegistrationSlotReservation struct {
	ID          uuid.UUID  `json:"id" db:"id"`
	SlotID      uuid.UUID  `json:"slot_id" db:"slot_id"`
	Token       string     `json:"-" db:"token"`
	ExpiresAt   time.Time  `json:"expires_at" db:"expires_at"`
	CompletedAt *time.Time `json:"completed_at" db:"completed_at"`
	ReleasedAt  *time.Time `json:"released_at" db:"released_at"`
	CreatedAt   time.Time  `json:"created_at" db:"created_at"`
}

// RegistrationGroupSummary is one row of the admin registration-groups table:
// the group plus aggregate slot counts.
type RegistrationGroupSummary struct {
	RegistrationGroup
	SlotsTotal    int `json:"slots_total"`
	SlotsConsumed int `json:"slots_consumed"`
	SlotsReserved int `json:"slots_reserved"`
}

// RegistrationSlotType is a group of identical slots (same server, tier,
// capacity, account status, and premium expiry), with per-status counts.
// SlotID is a representative free slot of this type when one exists (used by
// the public page to request a reservation), else any slot of the type.
type RegistrationSlotType struct {
	SlotID           uuid.UUID  `json:"slot_id"`
	ServerID         uuid.UUID  `json:"server_id"`
	ServerName       string     `json:"server_name"`
	DriveType        string     `json:"drive_type"`
	QuotaBytes       int64      `json:"quota_bytes"`
	AccountStatus    string     `json:"account_status"`
	PremiumExpiresAt *time.Time `json:"premium_expires_at,omitempty"`
	Total            int        `json:"total"`
	Consumed         int        `json:"consumed"`
	Reserved         int        `json:"reserved"`
	Available        int        `json:"available"`
}
