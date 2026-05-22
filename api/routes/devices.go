package routes

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type registerDeviceRequest struct {
	Name      string  `json:"name"       binding:"required,max=200"`
	Platform  string  `json:"platform"   binding:"required"`
	PushToken *string `json:"push_token"`
}

// RegisterDevice handles POST /api/v1/devices.
// Creates a device record for the authenticated user and returns the device ID.
func (h *Handler) RegisterDevice(c *gin.Context) {
	userID, err := uuid.Parse(c.GetString("userID"))
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	var req registerDeviceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Platform != "ios" && req.Platform != "android" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "platform must be ios or android"})
		return
	}

	device, err := h.queries.CreateDevice(c.Request.Context(), userID, req.Name, req.Platform, req.PushToken)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not register device"})
		return
	}
	c.JSON(http.StatusCreated, device)
}

// DeleteDevice handles DELETE /api/v1/devices/:device_id.
// Removes a device registration. Only the owning user may delete their devices.
func (h *Handler) DeleteDevice(c *gin.Context) {
	userID, err := uuid.Parse(c.GetString("userID"))
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	deviceID, err := uuid.Parse(c.Param("device_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid device_id"})
		return
	}

	device, err := h.queries.GetDevice(c.Request.Context(), deviceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "device not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal server error"})
		return
	}
	if device.UserID != userID {
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return
	}

	if err := h.queries.DeleteDevice(c.Request.Context(), deviceID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete device"})
		return
	}
	c.Status(http.StatusNoContent)
}
