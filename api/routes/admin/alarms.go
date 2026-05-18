package admin

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/db"
)

// GetAlarmSettings handles GET /api/v1/admin/system/alarm/settings.
func (h *Handler) GetAlarmSettings(c *gin.Context) {
	settings, err := h.queries.GetAlarmSettings(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load alarm settings"})
		return
	}
	c.JSON(http.StatusOK, settings)
}

type updateAlarmSettingsRequest struct {
	NotifyEmails          []string `json:"notify_emails"`
	CPUUsageEnabled       bool     `json:"cpu_usage_enabled"`
	CPUTempEnabled        bool     `json:"cpu_temp_enabled"`
	DriveTempEnabled      bool     `json:"drive_temp_enabled"`
	DriveLoadEnabled      bool     `json:"drive_load_enabled"`
	NetworkTrafficEnabled bool     `json:"network_traffic_enabled"`
	APIErrorRateEnabled   bool     `json:"api_error_rate_enabled"`
}

// UpdateAlarmSettings handles PUT /api/v1/admin/system/alarm/settings.
func (h *Handler) UpdateAlarmSettings(c *gin.Context) {
	var req updateAlarmSettingsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	if req.NotifyEmails == nil {
		req.NotifyEmails = []string{}
	}

	settings, err := h.queries.UpdateAlarmSettings(c.Request.Context(), db.UpdateAlarmSettingsParams{
		NotifyEmails:          req.NotifyEmails,
		CPUUsageEnabled:       req.CPUUsageEnabled,
		CPUTempEnabled:        req.CPUTempEnabled,
		DriveTempEnabled:      req.DriveTempEnabled,
		DriveLoadEnabled:      req.DriveLoadEnabled,
		NetworkTrafficEnabled: req.NetworkTrafficEnabled,
		APIErrorRateEnabled:   req.APIErrorRateEnabled,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update alarm settings"})
		return
	}
	c.JSON(http.StatusOK, settings)
}
