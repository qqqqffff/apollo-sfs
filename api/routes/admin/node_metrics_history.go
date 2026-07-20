package admin

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// parseHoursWindow reads and validates the ?hours= query param (1..72).
func parseHoursWindow(c *gin.Context) (int, bool) {
	hours, err := strconv.Atoi(c.Query("hours"))
	if err != nil || hours <= 0 || hours > 72 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "hours must be a positive integer ≤ 72"})
		return 0, false
	}
	return hours, true
}

// GetNodeMetricsHistory handles
// GET /api/v1/admin/system/nodes/:node_id/metrics/history?hours=N.
// Returns ~120 downsampled hardware snapshots for one node, oldest-first.
func (h *Handler) GetNodeMetricsHistory(c *gin.Context) {
	nodeID, err := uuid.Parse(c.Param("node_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid node_id"})
		return
	}
	hours, ok := parseHoursWindow(c)
	if !ok {
		return
	}
	snaps, err := h.metrics.GetNodeHistoryByHours(c.Request.Context(), nodeID, hours)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve node metrics history"})
		return
	}
	c.JSON(http.StatusOK, snaps)
}

// GetDriveTempsHistory handles
// GET /api/v1/admin/system/drives/:drive_id/temps/history?hours=N.
// Returns ~120 downsampled temperature readings for one drive, oldest-first.
func (h *Handler) GetDriveTempsHistory(c *gin.Context) {
	driveID, err := uuid.Parse(c.Param("drive_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid drive_id"})
		return
	}
	hours, ok := parseHoursWindow(c)
	if !ok {
		return
	}
	temps, err := h.metrics.GetDriveTempHistoryByHours(c.Request.Context(), driveID, hours)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve drive temperature history"})
		return
	}
	c.JSON(http.StatusOK, temps)
}

// GetNodeDisks handles GET /api/v1/admin/system/nodes/:node_id/disks.
// Returns every physical disk currently reported for a node, with its latest
// capacity/temperature — independent of which logical drives they back.
func (h *Handler) GetNodeDisks(c *gin.Context) {
	nodeID, err := uuid.Parse(c.Param("node_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid node_id"})
		return
	}
	disks, err := h.metrics.GetNodeDisks(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve node disks"})
		return
	}
	c.JSON(http.StatusOK, disks)
}

// GetNodeDiskTempsHistory handles
// GET /api/v1/admin/system/disks/:disk_id/temps/history?hours=N.
// Returns ~120 downsampled temperature readings for one physical disk.
func (h *Handler) GetNodeDiskTempsHistory(c *gin.Context) {
	diskID, err := uuid.Parse(c.Param("disk_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid disk_id"})
		return
	}
	hours, ok := parseHoursWindow(c)
	if !ok {
		return
	}
	temps, err := h.metrics.GetNodeDiskTempHistoryByHours(c.Request.Context(), diskID, hours)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve disk temperature history"})
		return
	}
	c.JSON(http.StatusOK, temps)
}

// GetDriveIOHistory handles
// GET /api/v1/admin/system/drives/:drive_id/io/history?hours=N.
// Returns ~120 downsampled read/write cumulative-counter readings for one
// drive, oldest-first — the frontend diffs adjacent points for bytes/second.
func (h *Handler) GetDriveIOHistory(c *gin.Context) {
	driveID, err := uuid.Parse(c.Param("drive_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid drive_id"})
		return
	}
	hours, ok := parseHoursWindow(c)
	if !ok {
		return
	}
	io, err := h.metrics.GetDriveIOHistoryByHours(c.Request.Context(), driveID, hours)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve drive I/O history"})
		return
	}
	c.JSON(http.StatusOK, io)
}

// GetNodeDiskIOHistory handles
// GET /api/v1/admin/system/disks/:disk_id/io/history?hours=N.
// Returns ~120 downsampled read/write cumulative-counter readings for one
// physical disk, oldest-first.
func (h *Handler) GetNodeDiskIOHistory(c *gin.Context) {
	diskID, err := uuid.Parse(c.Param("disk_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid disk_id"})
		return
	}
	hours, ok := parseHoursWindow(c)
	if !ok {
		return
	}
	io, err := h.metrics.GetNodeDiskIOHistoryByHours(c.Request.Context(), diskID, hours)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve disk I/O history"})
		return
	}
	c.JSON(http.StatusOK, io)
}
