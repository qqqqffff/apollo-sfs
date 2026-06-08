package routes

import (
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

type checkHashRequest struct {
	SHA256Hash string `json:"sha256_hash" binding:"required,len=64"`
}

// DeltaSync handles GET /api/v1/sync/delta.
// Returns all files created and all file IDs deleted since the given cursor.
// Query params:
//
//	since  — RFC 3339 timestamp (required); use server_time from the previous response
//	device_id — device UUID (optional, updates last_seen_at)
func (h *Handler) DeltaSync(c *gin.Context) {
	userID, err := uuid.Parse(c.GetString("userID"))
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	sinceStr := c.Query("since")
	if sinceStr == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "since is required (RFC 3339)"})
		return
	}
	since, err := time.Parse(time.RFC3339, sinceStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "since must be RFC 3339 (e.g. 2006-01-02T15:04:05Z)"})
		return
	}

	// Best-effort: bump device last_seen_at.
	if deviceIDStr := c.Query("device_id"); deviceIDStr != "" {
		if deviceID, err := uuid.Parse(deviceIDStr); err == nil {
			_ = h.queries.UpdateDeviceLastSeen(c.Request.Context(), deviceID, nil)
		}
	}

	serverTime := time.Now().UTC()

	files, err := h.queries.DeltaSyncFiles(c.Request.Context(), userID, since)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal server error"})
		return
	}

	deletedIDs, err := h.queries.DeltaSyncDeleted(c.Request.Context(), userID, since)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal server error"})
		return
	}

	// Never return nil slices — mobile clients expect arrays.
	if files == nil {
		files = []models.File{}
	}
	if deletedIDs == nil {
		deletedIDs = []uuid.UUID{}
	}

	c.JSON(http.StatusOK, gin.H{
		"files":       files,
		"deleted_ids": deletedIDs,
		"server_time": serverTime,
	})
}

// CheckHash handles POST /api/v1/sync/check-hash.
// Returns whether the authenticated user already has a file with the given SHA-256 hash.
// Used by mobile clients to skip redundant uploads (content-based dedup).
func (h *Handler) CheckHash(c *gin.Context) {
	userID, err := uuid.Parse(c.GetString("userID"))
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	var req checkHashRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	file, err := h.queries.FindFileByHash(c.Request.Context(), userID, req.SHA256Hash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusOK, gin.H{"exists": false})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal server error"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"exists": true, "file_id": file.ID})
}
