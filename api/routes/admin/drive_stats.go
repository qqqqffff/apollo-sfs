package admin

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// DriveStat is the live, per-drive view of a mounted storage device: real-time
// capacity/used/free reported by the owning node's agent, plus its temperature
// when a matching hardware sensor is found. Online is false when no agent has
// recently reported the drive (e.g. the node is offline), in which case the UI
// falls back to the capacity stored in the DB.
type DriveStat struct {
	Label       string   `json:"label"`
	TotalBytes  int64    `json:"total_bytes"`
	UsedBytes   int64    `json:"used_bytes"`
	FreeBytes   int64    `json:"free_bytes"`
	TempCelsius *float64 `json:"temp_celsius"`
	Online      bool     `json:"online"`
}

// GetDriveStats handles GET /api/v1/admin/system/drive-stats.
// It overlays the latest per-node hardware pushes (live capacity/used/free +
// temperature, sourced from each node's agent) onto the registered drive list.
// The response is keyed by drive_id. Drives not currently reported by an online
// node are returned with online=false so the UI can fall back to stored capacity.
func (h *Handler) GetDriveStats(c *gin.Context) {
	summaries, err := h.queries.GetDriveSummaries(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list drives"})
		return
	}

	// Index live drive frames by drive_id from the latest online node pushes.
	live := make(map[uuid.UUID]struct {
		total, used, free int64
		temp              *float64
	})
	nodeStates := []models.NodeFrame(nil)
	if h.metrics != nil {
		if ns, err := h.metrics.NodeStates(c.Request.Context()); err == nil {
			nodeStates = ns
		}
	}
	for _, n := range nodeStates {
		if !n.Online {
			continue
		}
		for _, d := range n.Drives {
			live[d.DriveID] = struct {
				total, used, free int64
				temp              *float64
			}{d.TotalBytes, d.UsedBytes, d.FreeBytes, d.TempCelsius}
		}
	}

	stats := make(map[string]DriveStat, len(summaries))
	for _, d := range summaries {
		st := DriveStat{Label: d.DriveLabel}
		if lv, ok := live[d.DriveID]; ok {
			st.TotalBytes = lv.total
			st.UsedBytes = lv.used
			st.FreeBytes = lv.free
			st.TempCelsius = lv.temp
			st.Online = true
		}
		stats[d.DriveID.String()] = st
	}

	c.JSON(http.StatusOK, gin.H{"stats": stats})
}
