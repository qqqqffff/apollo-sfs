package auth

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

type resetPasswordRequest struct {
	// Token is the `key` query parameter from the Keycloak password-reset email
	// link. The frontend should extract it from the Keycloak action URL and pass
	// it here alongside the new password.
	Token    string `json:"token"    binding:"required"`
	Password string `json:"password" binding:"required,min=8"`
}

// ResetPassword handles POST /api/v1/auth/reset_password.
// Validates the Keycloak action token and sets the user's new password via the
// Keycloak Admin API. Returns 400 for an invalid or expired token and 200 on
// success.
func (h *Handler) ResetPassword(c *gin.Context) {
	var req resetPasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "token and a password of at least 8 characters are required"})
		return
	}

	if err := h.svc.ResetPassword(c.Request.Context(), req.Token, req.Password); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "password updated successfully"})
}
