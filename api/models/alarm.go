package models

import "time"

// AlarmSettings mirrors the `alarm_settings` table (single row, id=1).
// Each boolean enables email notifications for that alarm condition.
// NotifyEmails is the list of addresses that receive alarm emails.
type AlarmSettings struct {
	NotifyEmails          []string  `json:"notify_emails"           db:"notify_emails"`
	CPUUsageEnabled       bool      `json:"cpu_usage_enabled"       db:"cpu_usage_enabled"`
	CPUTempEnabled        bool      `json:"cpu_temp_enabled"        db:"cpu_temp_enabled"`
	DriveTempEnabled      bool      `json:"drive_temp_enabled"      db:"drive_temp_enabled"`
	DriveLoadEnabled      bool      `json:"drive_load_enabled"      db:"drive_load_enabled"`
	NetworkTrafficEnabled bool      `json:"network_traffic_enabled" db:"network_traffic_enabled"`
	APIErrorRateEnabled   bool      `json:"api_error_rate_enabled"  db:"api_error_rate_enabled"`
	UpdatedAt             time.Time `json:"updated_at"              db:"updated_at"`
}
