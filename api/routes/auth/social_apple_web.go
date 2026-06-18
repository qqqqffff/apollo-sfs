package auth

import (
	"errors"
	"net/http"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/routes/middleware"
	"apollo-sfs.com/api/routes/services"
)

type appleWebLoginRequest struct {
	IdentityToken string `json:"identity_token" binding:"required"`
}

// AppleWebLogin handles POST /api/v1/auth/social/apple.
// Receives the id_token produced by the Sign in with Apple JS SDK, exchanges
// it for KC tokens via Keycloak's token-exchange grant, and writes a session
// cookie. If the Apple email matches an existing account a 409 is returned
// with conflict metadata so the frontend can surface the linking flow.
func (h *Handler) AppleWebLogin(c *gin.Context) {
	var req appleWebLoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "identity_token is required"})
		return
	}

	tokens, err := h.svc.WebSocialLogin(c.Request.Context(), "apple", req.IdentityToken)

	var conflict *services.ErrEmailConflict
	if errors.As(err, &conflict) {
		session := sessions.DefaultMany(c, middleware.SessionName)
		session.Set("pending_link_provider", conflict.Provider)
		session.Set("pending_link_kc_user_id", conflict.PendingKcUserID)
		_ = session.Save()

		c.JSON(http.StatusConflict, gin.H{
			"link_required":   true,
			"link_provider":   conflict.Provider,
			"link_email":      conflict.Email,
			"link_username":   conflict.ExistingUsername,
		})
		return
	}

	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "apple authentication failed"})
		return
	}

	session := sessions.DefaultMany(c, middleware.SessionName)
	session.Set("access_token", tokens.AccessToken)
	session.Set("refresh_token", tokens.RefreshToken)
	if err := session.Save(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{})
}
