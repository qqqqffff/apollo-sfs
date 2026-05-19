package admin

import (
	"net/http"

	"github.com/gin-gonic/gin"
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

type toggleAlarmSubscriptionRequest struct {
	AlarmType  string `json:"alarm_type"  binding:"required"`
	Subscribed bool   `json:"subscribed"`
}

// ToggleAlarmSubscription handles POST /api/v1/admin/system/alarm/subscribe.
// Adds or removes the current user's email from the named alarm's subscriber list.
func (h *Handler) ToggleAlarmSubscription(c *gin.Context) {
	var req toggleAlarmSubscriptionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "alarm_type is required"})
		return
	}

	username := c.GetString("username")
	user, err := h.queries.GetUserByUsername(c.Request.Context(), username)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not resolve user"})
		return
	}

	settings, err := h.queries.SetAlarmSubscription(c.Request.Context(), req.AlarmType, user.Email, req.Subscribed)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, settings)
}
