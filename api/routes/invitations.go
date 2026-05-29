package routes

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/routes/services"
)

// ValidateInvitationToken handles GET /api/v1/invitations/:token.
// Called by the registration page to confirm a token is valid before showing
// the registration form. Returns the invitee email so the form can be
// pre-filled. Does not consume the token.
func (h *Handler) ValidateInvitationToken(c *gin.Context) {
	token := c.Param("token")
	if token == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "token is required"})
		return
	}

	result, err := h.invites.Validate(c.Request.Context(), token)
	if err != nil {
		if errors.Is(err, services.ErrInviteNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		if errors.Is(err, services.ErrInviteExpired) {
			c.JSON(http.StatusGone, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not validate invitation"})
		return
	}

	c.JSON(http.StatusOK, result)
}
