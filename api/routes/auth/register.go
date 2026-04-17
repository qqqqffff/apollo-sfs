package auth

import (
	"net/http"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/routes/middleware"
)

type registerRequest struct {
	Username    string `json:"username"     binding:"required"`
	Email       string `json:"email"        binding:"required,email"`
	Password    string `json:"password"     binding:"required,min=8"`
	InviteToken string `json:"invite_token" binding:"required"`
}

// Register handles POST /api/v1/auth/register.
// Validates the invitation token, creates the user in Keycloak and the app DB,
// then auto-logs the user in by storing the new tokens in the session.
func (h *Handler) Register(c *gin.Context) {
	var req registerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	tokens, err := h.svc.Register(
		c.Request.Context(),
		req.Username,
		req.Email,
		req.Password,
		req.InviteToken,
	)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	session := sessions.DefaultMany(c, middleware.SessionName)
	session.Set("access_token", tokens.AccessToken)
	session.Set("refresh_token", tokens.RefreshToken)
	if err := session.Save(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save session"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"username": req.Username})
}
