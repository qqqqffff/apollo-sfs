package auth

import (
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
)

type forgotPasswordRequest struct {
	Email string `json:"email" binding:"required,email"`
}

// ForgotPassword handles POST /api/v1/auth/forgot_password.
// Triggers Keycloak's UPDATE_PASSWORD action email for the given address.
// Always responds 200 regardless of whether the email is registered to prevent
// user enumeration.
func (h *Handler) ForgotPassword(c *gin.Context) {
	var req forgotPasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "a valid email address is required"})
		return
	}

	if err := h.svc.ForgotPassword(c.Request.Context(), req.Email); err != nil {
		log.Printf("forgot password: %v", err)
	}

	// Always 200 — never reveal whether the address exists.
	c.JSON(http.StatusOK, gin.H{"message": "if that address is registered you will receive a reset email shortly"})
}
