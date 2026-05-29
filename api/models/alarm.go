package models

import "time"

// AlarmSettings mirrors the `alarm_settings` table (single row, id=1).
// Each alarm type has its own subscriber list (non-empty = enabled) and a
// last_fired_at timestamp that is persisted so the admin UI can display it.
type AlarmSettings struct {
	CPUUsageEmails            []string   `json:"cpu_usage_emails"              db:"cpu_usage_emails"`
	CPUUsageLastFiredAt       *time.Time `json:"cpu_usage_last_fired_at"       db:"cpu_usage_last_fired_at"`
	CPUTempEmails             []string   `json:"cpu_temp_emails"               db:"cpu_temp_emails"`
	CPUTempLastFiredAt        *time.Time `json:"cpu_temp_last_fired_at"        db:"cpu_temp_last_fired_at"`
	DriveTempEmails           []string   `json:"drive_temp_emails"             db:"drive_temp_emails"`
	DriveTempLastFiredAt      *time.Time `json:"drive_temp_last_fired_at"      db:"drive_temp_last_fired_at"`
	DriveLoadEmails           []string   `json:"drive_load_emails"             db:"drive_load_emails"`
	DriveLoadLastFiredAt      *time.Time `json:"drive_load_last_fired_at"      db:"drive_load_last_fired_at"`
	NetworkTrafficEmails      []string   `json:"network_traffic_emails"        db:"network_traffic_emails"`
	NetworkTrafficLastFiredAt *time.Time `json:"network_traffic_last_fired_at" db:"network_traffic_last_fired_at"`
	APIErrorRateEmails        []string   `json:"api_error_rate_emails"         db:"api_error_rate_emails"`
	APIErrorRateLastFiredAt   *time.Time `json:"api_error_rate_last_fired_at"  db:"api_error_rate_last_fired_at"`
	UpdatedAt                 time.Time  `json:"updated_at"                    db:"updated_at"`
}
