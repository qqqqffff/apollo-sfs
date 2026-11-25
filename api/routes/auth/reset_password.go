package auth

import (
	"errors"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/routes/services"
)

type resetPasswordRequest struct {
	// Token is the `token` query parameter of the emailed reset link, forwarded
	// by the frontend's /reset-password page.
	Token string `json:"token" binding:"required"`
	// min mirrors the Keycloak realm's length(12) policy — see
	// keycloak/import/realm.json. Keycloak rejects anything shorter anyway;
	// checking here turns that into a clear 400 instead of an admin-API error.
	NewPassword string `json:"new_password" binding:"required,min=12"`
}

// ResetPassword handles POST /api/v1/auth/reset_password.
// Consumes a single-use reset token issued by ForgotPassword and sets the new
// password via the Keycloak Admin API. Returns 400 for an invalid, used, or
// expired token and 200 on success.
func (h *Handler) ResetPassword(c *gin.Context) {
	var req resetPasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "token and a new password of at least 12 characters are required"})
		return
	}

	if err := h.svc.ResetPassword(c.Request.Context(), req.Token, req.NewPassword); err != nil {
		if errors.Is(err, services.ErrInvalidResetToken) {
			c.JSON(http.StatusBadRequest, gin.H{"error": services.ErrInvalidResetToken.Error()})
			return
		}
		// Anything else is our fault (Keycloak unreachable, DB error) — don't
		// echo the internal error to an unauthenticated caller.
		log.Printf("reset password: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not reset the password, please try again"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "password updated successfully"})
}
