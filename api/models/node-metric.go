package models

import (
	"time"

	"github.com/google/uuid"
)

// NodeMetricSnapshot mirrors the `node_metrics_snapshots` table — one row per
// node per 5-second sample. Hardware metrics are pushed to the API by the
// per-node agent (api/cmd/node-agent). network_bytes_* are cumulative counters
// since boot; diff adjacent rows to compute bytes/second. Pruned after 7 days.
type NodeMetricSnapshot struct {
	ID               uuid.UUID `json:"id" db:"id"`
	NodeID           uuid.UUID `json:"node_id" db:"node_id"`
	CPUPercent       float64   `json:"cpu_percent" db:"cpu_percent"`
	CPUTempCelsius   *float64  `json:"cpu_temp_celsius" db:"cpu_temp_celsius"`
	MemoryUsedBytes  int64     `json:"memory_used_bytes" db:"memory_used_bytes"`
	MemoryTotalBytes int64     `json:"memory_total_bytes" db:"memory_total_bytes"`
	NetworkBytesSent int64     `json:"network_bytes_sent" db:"network_bytes_sent"`
	NetworkBytesRecv int64     `json:"network_bytes_recv" db:"network_bytes_recv"`
	SampledAt        time.Time `json:"sampled_at" db:"sampled_at"`
}

// DriveTempSnapshot mirrors the `drive_temp_snapshots` table — one temperature
// reading per drive per sample. Backs the per-drive temperature history graph.
type DriveTempSnapshot struct {
	ID          uuid.UUID `json:"id" db:"id"`
	DriveID     uuid.UUID `json:"drive_id" db:"drive_id"`
	TempCelsius float64   `json:"temp_celsius" db:"temp_celsius"`
	SampledAt   time.Time `json:"sampled_at" db:"sampled_at"`
}

// NodeMetricsPayload is the JSON body the per-node agent POSTs to
// /api/v1/internal/node-metrics every sample. The agent identifies itself by
// hostname (its Docker Swarm node hostname); the API resolves it to a node row.
type NodeMetricsPayload struct {
	Hostname         string         `json:"hostname"`
	CPUPercent       float64        `json:"cpu_percent"`
	CPUTempCelsius   *float64       `json:"cpu_temp_celsius,omitempty"`
	MemoryUsedBytes  int64          `json:"memory_used_bytes"`
	MemoryTotalBytes int64          `json:"memory_total_bytes"`
	NetworkBytesSent int64          `json:"network_bytes_sent"`
	NetworkBytesRecv int64          `json:"network_bytes_recv"`
	Drives           []DrivePayload `json:"drives"`
}

// DrivePayload is one drive's live figures as reported by the node agent. Label
// is the filesystem label, matched to a registered drive on the reporting node.
type DrivePayload struct {
	Label       string   `json:"label"`
	Device      string   `json:"device"`
	TempCelsius *float64 `json:"temp_celsius,omitempty"`
	TotalBytes  int64    `json:"total_bytes"`
	UsedBytes   int64    `json:"used_bytes"`
	FreeBytes   int64    `json:"free_bytes"`
}

// MetricsFrame is the per-tick WebSocket payload broadcast to admin clients:
// cluster-wide metrics (uplink + app) plus a per-node hardware breakdown.
type MetricsFrame struct {
	Cluster *ServerMetricSnapshot `json:"cluster"`
	Nodes   []NodeFrame           `json:"nodes"`
}

// NodeFrame is one node's latest hardware state within a MetricsFrame.
type NodeFrame struct {
	NodeID           uuid.UUID    `json:"node_id"`
	Hostname         string       `json:"hostname"`
	Role             string       `json:"role"`
	IsActive         bool         `json:"is_active"`
	Online           bool         `json:"online"`
	CPUPercent       float64      `json:"cpu_percent"`
	CPUTempCelsius   *float64     `json:"cpu_temp_celsius"`
	MemoryUsedBytes  int64        `json:"memory_used_bytes"`
	MemoryTotalBytes int64        `json:"memory_total_bytes"`
	NetworkBytesSent int64        `json:"network_bytes_sent"`
	NetworkBytesRecv int64        `json:"network_bytes_recv"`
	SampledAt        time.Time    `json:"sampled_at"`
	Drives           []DriveFrame `json:"drives"`
}

// DriveFrame is one drive's live figures within a NodeFrame, resolved to its
// registered drive_id so the frontend can correlate with the infrastructure view.
type DriveFrame struct {
	DriveID     uuid.UUID `json:"drive_id"`
	Label       string    `json:"label"`
	DriveType   string    `json:"drive_type"`
	TempCelsius *float64  `json:"temp_celsius"`
	TotalBytes  int64     `json:"total_bytes"`
	UsedBytes   int64     `json:"used_bytes"`
	FreeBytes   int64     `json:"free_bytes"`
}
