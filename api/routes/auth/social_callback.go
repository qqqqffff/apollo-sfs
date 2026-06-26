package auth

import (
	"errors"
	"log"
	"net/http"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/routes/middleware"
	"apollo-sfs.com/api/routes/services"
)

// SocialCallback handles GET /api/v1/auth/social/callback.
// Keycloak redirects here after completing a social IDP login (Google, Apple).
// The authorization code is exchanged for tokens. If the social email matches
// an existing account, the user is redirected to the linking UI instead.
func (h *Handler) SocialCallback(c *gin.Context) {
	if errParam := c.Query("error"); errParam != "" {
		c.Redirect(http.StatusFound, "/login?social_error="+errParam)
		return
	}

	code := c.Query("code")
	if code == "" {
		c.Redirect(http.StatusFound, "/login?social_error=missing_code")
		return
	}

	// The provider is carried in state so we know which IDP we're coming back from.
	provider := c.Query("state")
	if provider != "google" && provider != "apple" {
		provider = "google" // safe fallback; state param is optional
	}

	redirectURI := h.svc.AppBaseURL() + "/api/v1/auth/social/callback"
	tokens, err := h.svc.AuthCodeExchange(c.Request.Context(), code, redirectURI, provider)

	// Email conflict — existing account found with the same email.
	var conflict *services.ErrEmailConflict
	if errors.As(err, &conflict) {
		session := sessions.DefaultMany(c, middleware.SessionName)
		session.Set("pending_link_provider", conflict.Provider)
		session.Set("pending_link_kc_user_id", conflict.PendingKcUserID)
		_ = session.Save()

		c.Redirect(http.StatusFound,
			"/login?link_provider="+conflict.Provider+
				"&link_email="+conflict.Email+
				"&link_username="+conflict.ExistingUsername)
		return
	}

	if err != nil {
		c.Redirect(http.StatusFound, "/login?social_error=exchange_failed")
		return
	}

	session := sessions.DefaultMany(c, middleware.SessionName)
	session.Set("refresh_token", tokens.RefreshToken) // access token minted on demand; see middleware.RequireAuth
	if err := session.Save(); err != nil {
		log.Printf("social_callback: session save failed: %v", err)
		c.Redirect(http.StatusFound, "/login?social_error=session_failed")
		return
	}

	c.Redirect(http.StatusFound, "/client")
}
