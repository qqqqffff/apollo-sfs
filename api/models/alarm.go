package models

import (
	"time"

	"github.com/google/uuid"
)

// AlarmType enumerates the supported alarm metrics. Each type implies a target
// scope (see AlarmSubscription) and a threshold unit:
//
//	cpu_usage        node    percent
//	cpu_temp         node    degrees Celsius
//	memory           node    percent
//	network_traffic  node    percent of the last speed test
//	drive_temp       drive   degrees Celsius
//	drive_load       drive   percent of capacity
//	api_error_rate   cluster percent
const (
	AlarmCPUUsage       = "cpu_usage"
	AlarmCPUTemp        = "cpu_temp"
	AlarmMemory         = "memory"
	AlarmNetworkTraffic = "network_traffic"
	AlarmDriveTemp      = "drive_temp"
	AlarmDriveLoad      = "drive_load"
	AlarmAPIErrorRate   = "api_error_rate"
)

// AlarmSubscription mirrors a row of the `alarm_subscriptions` table: one
// subscriber's alarm on one target (a node, a drive, or the whole cluster) with
// its own threshold. The DisplayName fields are populated by LEFT JOINs against
// nodes / drives / servers for the firing email and the admin/metrics UIs.
type AlarmSubscription struct {
	ID          uuid.UUID  `json:"id"            db:"id"`
	Email       string     `json:"email"         db:"email"`
	AlarmType   string     `json:"alarm_type"    db:"alarm_type"`
	NodeID      *uuid.UUID `json:"node_id"       db:"node_id"`
	DriveID     *uuid.UUID `json:"drive_id"      db:"drive_id"`
	Threshold   float64    `json:"threshold"     db:"threshold"`
	LastFiredAt *time.Time `json:"last_fired_at" db:"last_fired_at"`

	// Join-only display fields (not persisted on this table).
	NodeHostname string `json:"node_hostname,omitempty" db:"-"`
	NodeRole     string `json:"node_role,omitempty"     db:"-"`
	DriveLabel   string `json:"drive_label,omitempty"   db:"-"`
	ServerName   string `json:"server_name,omitempty"   db:"-"`
}
