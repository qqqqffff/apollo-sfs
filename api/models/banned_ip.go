package models

import "time"

// BannedIP mirrors the banned_ips table. The Country and City fields are not
// stored in the database — they are populated from a geo-lookup at query time.
type BannedIP struct {
	ID         int64      `json:"id"          db:"id"`
	IP         string     `json:"ip"          db:"ip"`
	Jail       string     `json:"jail"        db:"jail"`
	BannedAt   time.Time  `json:"banned_at"   db:"banned_at"`
	UnbannedAt *time.Time `json:"unbanned_at" db:"unbanned_at"`
	BanCount   int        `json:"ban_count"   db:"ban_count"`
	Country    string     `json:"country"`
	City       string     `json:"city"`
}
