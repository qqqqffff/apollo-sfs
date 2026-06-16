package storage

import (
	"bytes"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Handler wires the /api/v1/storage/* user-facing endpoints.
// These are intentionally separate from /api/v1/admin/system/* so that
// regular users can query their own server metrics without admin access.
type Handler struct {
	queries Querier
	rl      *speedRateLimiter
}

func NewHandler(q Querier) *Handler {
	return &Handler{
		queries: q,
		rl:      newSpeedRateLimiter(5),
	}
}

// ── GET /api/v1/storage/servers ───────────────────────────────────────────────

type serverResponse struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	State              string `json:"state"`
	TotalCapacityBytes int64  `json:"total_capacity_bytes"`
	AvailableBytes     int64  `json:"available_bytes"`
	PingURL            string `json:"ping_url"`
}

// ListServers returns all active servers with their aggregated capacity so the
// client can measure ping to each and present a sorted server picker.
func (h *Handler) ListServers(c *gin.Context) {
	servers, err := h.queries.ListServerCapacities(c.Request.Context())
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list servers"})
		return
	}

	resp := make([]serverResponse, len(servers))
	for i, s := range servers {
		resp[i] = serverResponse{
			ID:                 s.ServerID.String(),
			Name:               s.Name,
			State:              s.State,
			TotalCapacityBytes: s.TotalCapacityBytes,
			AvailableBytes:     s.AvailableBytes,
			PingURL:            fmt.Sprintf("/api/v1/storage/servers/%s/ping", s.ServerID),
		}
	}

	c.JSON(http.StatusOK, gin.H{"servers": resp})
}

// ── GET /api/v1/storage/servers/:server_id/ping ───────────────────────────────

// PingServer is a no-op endpoint used by clients to measure round-trip latency
// to this API for a given server identifier. Returns 204 immediately.
func (h *Handler) PingServer(c *gin.Context) {
	rawID := c.Param("server_id")
	if _, err := uuid.Parse(rawID); err != nil {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	c.Status(http.StatusNoContent)
}

// ── GET /api/v1/storage/breakdown ────────────────────────────────────────────

type serverInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	State      string `json:"state"`
	DriveLabel string `json:"drive_label"`
	PingURL    string `json:"ping_url"`
}

type breakdownResponse struct {
	UsedBytes  int64       `json:"used_bytes"`
	QuotaBytes int64       `json:"quota_bytes"`
	NVMEBytes  int64       `json:"nvme_bytes"`
	HDDBytes   int64       `json:"hdd_bytes"`
	Server     *serverInfo `json:"server"`
}

// GetBreakdown returns the authenticated user's storage breakdown:
// total quota, used bytes, NVMe vs HDD allocations, and their assigned server.
func (h *Handler) GetBreakdown(c *gin.Context) {
	username := c.GetString("username")

	user, err := h.queries.GetUserByUsername(c.Request.Context(), username)
	if err != nil || user == nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load user"})
		return
	}

	breakdown, err := h.queries.GetUserStorageBreakdown(c.Request.Context(), username)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load breakdown"})
		return
	}

	alloc, err := h.queries.GetUserDrive(c.Request.Context(), username)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load allocation"})
		return
	}

	resp := breakdownResponse{
		UsedBytes:  user.StorageUsedBytes,
		QuotaBytes: user.StorageQuotaBytes,
		NVMEBytes:  breakdown.NVMEBytes,
		HDDBytes:   breakdown.HDDBytes,
	}

	if alloc != nil {
		resp.Server = &serverInfo{
			ID:         alloc.Server.ID.String(),
			Name:       alloc.Server.Name,
			State:      alloc.Server.State,
			DriveLabel: alloc.Drive.Label,
			PingURL:    fmt.Sprintf("/api/v1/storage/servers/%s/ping", alloc.Server.ID),
		}
	}

	c.JSON(http.StatusOK, resp)
}

// ── GET /api/v1/storage/speed/download ───────────────────────────────────────

const speedTestSize = 1 << 20 // 1 MiB

// SpeedTestDownload serves a 1 MiB payload of zeros so the client can measure
// download throughput to the API. Rate-limited to 5 calls/min per user (shared
// with the upload endpoint so the combined total stays within the limit).
func (h *Handler) SpeedTestDownload(c *gin.Context) {
	username := c.GetString("username")
	if !h.rl.Allow(username) {
		c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
			"error":   "rate_limit_exceeded",
			"message": "Maximum 5 speed tests per minute",
		})
		return
	}

	buf := make([]byte, speedTestSize)
	c.DataFromReader(http.StatusOK, speedTestSize, "application/octet-stream",
		bytes.NewReader(buf), nil)
}

// ── POST /api/v1/storage/speed/upload ────────────────────────────────────────

// SpeedTestUpload accepts and discards a body so the client can measure upload
// throughput to the API. Rate-limited alongside the download endpoint.
func (h *Handler) SpeedTestUpload(c *gin.Context) {
	username := c.GetString("username")
	if !h.rl.Allow(username) {
		c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
			"error":   "rate_limit_exceeded",
			"message": "Maximum 5 speed tests per minute",
		})
		return
	}

	io.Copy(io.Discard, c.Request.Body) //nolint:errcheck
	c.JSON(http.StatusOK, gin.H{"received": true})
}
