package admin

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/routes/services"
)

type createInvitationRequest struct {
	Email string `json:"email" binding:"required,email"`
}

// CreateInvitation handles POST /api/v1/admin/invitations.
// Generates a secure token, persists the invitation, and enqueues the invite email.
func (h *Handler) CreateInvitation(c *gin.Context) {
	var req createInvitationRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "a valid email address is required"})
		return
	}

	invitedByUserID, _ := c.Get("userID")
	invitedByUsername, _ := c.Get("username")

	userID, err := uuid.Parse(invitedByUserID.(string))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "invalid user context"})
		return
	}

	inv, err := h.invites.Create(c.Request.Context(), userID, invitedByUsername.(string), req.Email)
	if err != nil {
		if errors.Is(err, services.ErrInviteAlreadyPending) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create invitation"})
		return
	}

	c.JSON(http.StatusCreated, inv)
}

// GetInvitations handles GET /api/v1/admin/invitations.
// Returns a paginated list of all invitations ordered by creation time descending.
func (h *Handler) GetInvitations(c *gin.Context) {
	page := db.PageInput{
		Cursor: c.Query("cursor"),
	}
	if err := parseLimit(c, &page.Limit); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be a positive integer"})
		return
	}

	result, err := h.invites.List(c.Request.Context(), page)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list invitations"})
		return
	}

	c.JSON(http.StatusOK, result)
}

// RevokeInvitation handles DELETE /api/v1/admin/invitations/:id.
// Sets revoked_at on the invitation row. Idempotent — revoking an already-revoked
// invitation returns 200.
func (h *Handler) RevokeInvitation(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid invitation id"})
		return
	}

	if err := h.invites.Revoke(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not revoke invitation"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "invitation revoked"})
}

// parseLimit reads the ?limit query param into dst, leaving it at 0 (default)
// if the param is absent.
func parseLimit(c *gin.Context, dst *int) error {
	raw := c.Query("limit")
	if raw == "" {
		return nil
	}
	var n int
	if _, err := fmt.Sscanf(raw, "%d", &n); err != nil || n < 1 {
		return errors.New("invalid limit")
	}
	*dst = n
	return nil
}
