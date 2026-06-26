package auth

import (
	"log"
	"net/http"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/routes/middleware"
)

type socialLinkRequest struct {
	Username string `json:"username" binding:"required,max=150"`
	Password string `json:"password" binding:"required,max=1024"`
}

// SocialLinkConfirm handles POST /api/v1/auth/social/link.
// The user has confirmed they own an existing account by supplying their
// credentials. This endpoint links the pending social identity (stored in the
// session from SocialCallback) to the existing Keycloak user, then logs them in.
func (h *Handler) SocialLinkConfirm(c *gin.Context) {
	var req socialLinkRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username and password are required"})
		return
	}

	session := sessions.DefaultMany(c, middleware.SessionName)
	provider, _ := session.Get("pending_link_provider").(string)
	pendingKcUserID, _ := session.Get("pending_link_kc_user_id").(string)

	if provider == "" || pendingKcUserID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no pending link session — please start the sign-in again"})
		return
	}

	tokens, err := h.svc.LinkSocialAccount(c.Request.Context(), req.Username, req.Password, pendingKcUserID, provider)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	// Clear the pending link keys and store the real session tokens.
	session.Delete("pending_link_provider")
	session.Delete("pending_link_kc_user_id")
	session.Set("refresh_token", tokens.RefreshToken) // access token minted on demand; see middleware.RequireAuth
	if err := session.Save(); err != nil {
		log.Printf("social_link: session save failed: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"username": req.Username})
}
