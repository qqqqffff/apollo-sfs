package routes

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/routes/services"
)

// regGroupsConfigured guards the public group-invite endpoints against a nil
// service (main not wired, e.g. some tests).
func (h *Handler) regGroupsConfigured(c *gin.Context) bool {
	if h.regGroups == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "group registration is not configured"})
		return false
	}
	return true
}

// GetGroupInvite handles GET /api/v1/group-invites/:link_id.
// Public: resolves the group behind a /group-invite?id=<link_id> link and
// returns its slot types with live availability counts.
func (h *Handler) GetGroupInvite(c *gin.Context) {
	if !h.regGroupsConfigured(c) {
		return
	}
	linkID := c.Param("link_id")
	invite, err := h.regGroups.PublicInvite(c.Request.Context(), linkID)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrGroupNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "this registration link does not exist"})
		case errors.Is(err, services.ErrGroupInactive), errors.Is(err, services.ErrGroupExpired):
			c.JSON(http.StatusGone, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load the registration group"})
		}
		return
	}
	c.JSON(http.StatusOK, invite)
}

type reserveSlotRequest struct {
	SlotID uuid.UUID `json:"slot_id" binding:"required"`
}

// ReserveGroupSlot handles POST /api/v1/group-invites/:link_id/reservations.
// Public: places a 10-minute hold on a free slot of the selected type and
// returns the reservation token the register page carries as
// /register?reservation=<token>.
func (h *Handler) ReserveGroupSlot(c *gin.Context) {
	if !h.regGroupsConfigured(c) {
		return
	}
	var req reserveSlotRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "slot_id is required"})
		return
	}
	token, expiresAt, err := h.regGroups.Reserve(c.Request.Context(), c.Param("link_id"), req.SlotID)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrGroupNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "this registration link does not exist"})
		case errors.Is(err, services.ErrGroupInactive), errors.Is(err, services.ErrGroupExpired):
			c.JSON(http.StatusGone, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrNoSlotAvailable):
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not reserve the slot"})
		}
		return
	}
	c.JSON(http.StatusCreated, gin.H{"reservation_token": token, "expires_at": expiresAt})
}

// GetSlotReservation handles GET /api/v1/group-invites/reservations/:token.
// Public: resolves a reservation for the register page. Expired/completed
// holds resolve with their status (not an error) so the page can show the
// session-expired modal with a link back to the group page.
func (h *Handler) GetSlotReservation(c *gin.Context) {
	if !h.regGroupsConfigured(c) {
		return
	}
	v, err := h.regGroups.ValidateReservation(c.Request.Context(), c.Param("token"))
	if err != nil {
		if errors.Is(err, services.ErrReservationNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "registration session not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load the registration session"})
		return
	}
	c.JSON(http.StatusOK, v)
}

// ReleaseSlotReservation handles DELETE /api/v1/group-invites/reservations/:token.
// Public: frees a still-open hold when the user backs out of the registration
// form, so someone else can claim the slot immediately. Idempotent.
func (h *Handler) ReleaseSlotReservation(c *gin.Context) {
	if !h.regGroupsConfigured(c) {
		return
	}
	if err := h.regGroups.Release(c.Request.Context(), c.Param("token")); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not release the registration session"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "released"})
}
