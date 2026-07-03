package admin

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// alarmScope classifies an alarm type's required target dimension.
type alarmScope int

const (
	scopeNode alarmScope = iota
	scopeDrive
	scopeCluster
)

func scopeFor(alarmType string) (alarmScope, bool) {
	switch alarmType {
	case models.AlarmCPUUsage, models.AlarmCPUTemp, models.AlarmMemory, models.AlarmNetworkTraffic:
		return scopeNode, true
	case models.AlarmDriveTemp, models.AlarmDriveLoad:
		return scopeDrive, true
	case models.AlarmAPIErrorRate:
		return scopeCluster, true
	default:
		return 0, false
	}
}

// resolveAlarmEmail returns the email whose subscriptions an admin request
// targets. An empty username means the calling admin's own account.
func (h *Handler) resolveAlarmEmail(c *gin.Context, username string) (string, bool) {
	if username == "" {
		username = c.GetString("username")
	}
	user, err := h.queries.GetUserByUsername(c.Request.Context(), username)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "could not resolve user"})
		return "", false
	}
	return user.Email, true
}

// GetAlarmSubscriptions handles GET /api/v1/admin/system/alarm/subscriptions.
// Without ?username it returns the caller's subscriptions; with ?username it
// returns that user's (admin review).
func (h *Handler) GetAlarmSubscriptions(c *gin.Context) {
	email, ok := h.resolveAlarmEmail(c, c.Query("username"))
	if !ok {
		return
	}
	subs, err := h.queries.ListAlarmSubscriptionsByEmail(c.Request.Context(), email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load alarm subscriptions"})
		return
	}
	if subs == nil {
		subs = []models.AlarmSubscription{}
	}
	c.JSON(http.StatusOK, subs)
}

type alarmSubscriptionRequest struct {
	AlarmType string     `json:"alarm_type" binding:"required"`
	NodeID    *uuid.UUID `json:"node_id"`
	DriveID   *uuid.UUID `json:"drive_id"`
	Threshold float64    `json:"threshold"`
	Username  string     `json:"username"`
}

// validateScope enforces that the target dimensions match the alarm type.
func (r *alarmSubscriptionRequest) validateScope() (alarmScope, bool) {
	scope, ok := scopeFor(r.AlarmType)
	if !ok {
		return 0, false
	}
	switch scope {
	case scopeNode:
		return scope, r.NodeID != nil && r.DriveID == nil
	case scopeDrive:
		return scope, r.DriveID != nil && r.NodeID == nil
	default: // scopeCluster
		return scope, r.NodeID == nil && r.DriveID == nil
	}
}

// UpsertAlarmSubscription handles PUT /api/v1/admin/system/alarm/subscriptions.
// Creates or updates the threshold for one (subscriber, alarm type, target).
func (h *Handler) UpsertAlarmSubscription(c *gin.Context) {
	var req alarmSubscriptionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "alarm_type is required"})
		return
	}
	if _, valid := req.validateScope(); !valid {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid alarm_type or target for its scope"})
		return
	}
	if req.Threshold <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "threshold must be positive"})
		return
	}

	email, ok := h.resolveAlarmEmail(c, req.Username)
	if !ok {
		return
	}
	sub, err := h.queries.UpsertAlarmSubscription(c.Request.Context(), email, req.AlarmType, req.NodeID, req.DriveID, req.Threshold)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save alarm subscription"})
		return
	}
	c.JSON(http.StatusOK, sub)
}

// DeleteAlarmSubscription handles DELETE /api/v1/admin/system/alarm/subscriptions.
func (h *Handler) DeleteAlarmSubscription(c *gin.Context) {
	var req alarmSubscriptionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "alarm_type is required"})
		return
	}
	if _, valid := scopeFor(req.AlarmType); !valid {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unknown alarm_type"})
		return
	}

	email, ok := h.resolveAlarmEmail(c, req.Username)
	if !ok {
		return
	}
	if err := h.queries.DeleteAlarmSubscription(c.Request.Context(), email, req.AlarmType, req.NodeID, req.DriveID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete alarm subscription"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
