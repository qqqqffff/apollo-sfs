package models

import (
	"time"

	"github.com/google/uuid"
)

// ServerMetricSnapshot mirrors the `server_metrics_snapshots` table.
// Rows are inserted every 5 seconds by a background goroutine and pruned after
// 7 days. network_bytes_sent and network_bytes_recv are cumulative counters
// since system boot — diff adjacent rows to compute bytes/second.
type ServerMetricSnapshot struct {
	ID                     uuid.UUID `json:"id" db:"id"`
	CPUPercent             float64   `json:"cpu_percent" db:"cpu_percent"`
	MemoryUsedBytes        int64     `json:"memory_used_bytes" db:"memory_used_bytes"`
	MemoryTotalBytes       int64     `json:"memory_total_bytes" db:"memory_total_bytes"`
	NetworkBytesSent       int64     `json:"network_bytes_sent" db:"network_bytes_sent"`
	NetworkBytesRecv       int64     `json:"network_bytes_recv" db:"network_bytes_recv"`
	StorageTotalUsedBytes  int64     `json:"storage_total_used_bytes" db:"storage_total_used_bytes"`
	StorageTotalQuotaBytes int64     `json:"storage_total_quota_bytes" db:"storage_total_quota_bytes"`
	DiskTotalBytes         int64     `json:"disk_total_bytes" db:"disk_total_bytes"`
	DiskFreeBytes          int64     `json:"disk_free_bytes" db:"disk_free_bytes"`
	ActiveUserCount        int       `json:"active_user_count" db:"active_user_count"`
	TotalUserCount         int       `json:"total_user_count" db:"total_user_count"`
	SampledAt              time.Time `json:"sampled_at" db:"sampled_at"`
	// Nullable — set to nil when the host has no accessible temperature sensors.
	CPUTempCelsius   *float64 `json:"cpu_temp_celsius" db:"cpu_temp_celsius"`
	DriveTempCelsius *float64 `json:"drive_temp_celsius" db:"drive_temp_celsius"`
	// Nullable — set to nil when ICMP ping is unavailable (e.g. missing capability).
	ServerISPPingMs            *float64 `json:"server_isp_ping_ms" db:"server_isp_ping_ms"`
	ServerISPPacketLossPercent *float64 `json:"server_isp_packet_loss_percent" db:"server_isp_packet_loss_percent"`
}
