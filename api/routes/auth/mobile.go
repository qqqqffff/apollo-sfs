package auth

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/routes/services"
)

type mobileLoginRequest struct {
	Email    string `json:"email" binding:"required,email,max=254"`
	Password string `json:"password" binding:"required,max=1024"`
}

type mobileRefreshRequest struct {
	RefreshToken string `json:"refresh_token" binding:"required"`
}

type mobileAppleRequest struct {
	IdentityToken string `json:"identity_token" binding:"required"`
}

// tokenResponse is the JSON shape returned by all mobile auth endpoints.
type tokenResponse struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	ExpiresIn        int    `json:"expires_in"`
	RefreshExpiresIn int    `json:"refresh_expires_in,omitempty"`
}

// MobileLogin handles POST /api/v1/mobile/auth/login.
// Returns tokens as JSON (no session cookie) for native mobile clients.
func (h *Handler) MobileLogin(c *gin.Context) {
	var req mobileLoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email and password are required"})
		return
	}
	req.Email = strings.TrimSpace(req.Email)
	if req.Email == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email and password are required"})
		return
	}

	tokens, err := h.svc.Login(c.Request.Context(), req.Email, req.Password)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	c.JSON(http.StatusOK, tokenResponse{
		AccessToken:      tokens.AccessToken,
		RefreshToken:     tokens.RefreshToken,
		ExpiresIn:        tokens.ExpiresIn,
		RefreshExpiresIn: tokens.RefreshExpiresIn,
	})
}

// MobileRefresh handles POST /api/v1/mobile/auth/refresh.
// Exchanges a refresh token for a new token pair without a session cookie.
func (h *Handler) MobileRefresh(c *gin.Context) {
	var req mobileRefreshRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "refresh_token is required"})
		return
	}

	tokens, err := h.svc.Refresh(c.Request.Context(), req.RefreshToken)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired refresh token"})
		return
	}

	c.JSON(http.StatusOK, tokenResponse{
		AccessToken:      tokens.AccessToken,
		RefreshToken:     tokens.RefreshToken,
		ExpiresIn:        tokens.ExpiresIn,
		RefreshExpiresIn: tokens.RefreshExpiresIn,
	})
}

// MobileAppleLogin handles POST /api/v1/mobile/auth/apple.
// Exchanges an Apple identity token for Apollo SFS tokens via Keycloak Token Exchange.
func (h *Handler) MobileAppleLogin(c *gin.Context) {
	var req mobileAppleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "identity_token is required"})
		return
	}

	tokens, err := h.svc.SocialLogin(c.Request.Context(), "apple", req.IdentityToken)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "apple authentication failed: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, tokenResponse{
		AccessToken:      tokens.AccessToken,
		RefreshToken:     tokens.RefreshToken,
		ExpiresIn:        tokens.ExpiresIn,
		RefreshExpiresIn: tokens.RefreshExpiresIn,
	})
}

// MobileGoogleLogin handles POST /api/v1/mobile/auth/google.
//
// DEPRECATED: Google login moved to Keycloak identity-provider brokering. The
// app now obtains realm tokens directly from Keycloak via a browser-based
// Authorization Code + PKCE flow (kc_idp_hint=google), then calls
// POST /mobile/auth/session to provision. This endpoint relied on Keycloak's
// external token exchange, which Standard Token Exchange v2 no longer supports.
// Kept registered so stale app builds receive a clear signal instead of a 404.
func (h *Handler) MobileGoogleLogin(c *gin.Context) {
	c.JSON(http.StatusGone, gin.H{
		"error": "google login moved to identity-provider brokering; please update the app",
	})
}

type mobileSessionRequest struct {
	// InviteToken is required only for first-time (registration) social logins;
	// existing users omit it.
	InviteToken string `json:"invite_token"`
}

// MobileSession handles POST /api/v1/mobile/auth/session.
//
// Called by the app immediately after a brokered (Keycloak identity-provider)
// login. For existing users it ensures the app-side record exists; for new users
// it requires a valid invitation (otherwise the auto-created Keycloak account is
// rolled back). Brokered logins receive tokens directly from Keycloak, bypassing
// the backend login path where provisioning normally runs. RequireAuth has
// already validated the bearer token by the time this handler executes.
func (h *Handler) MobileSession(c *gin.Context) {
	token := strings.TrimSpace(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer "))
	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing bearer token"})
		return
	}
	var req mobileSessionRequest
	_ = c.ShouldBindJSON(&req) // body is optional — ordinary logins send none

	if err := h.svc.ProvisionBrokeredUser(c.Request.Context(), token, req.InviteToken); err != nil {
		if errors.Is(err, services.ErrInvitationRequired) {
			c.JSON(http.StatusForbidden, gin.H{"error": "a valid invitation is required to register"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "session provisioning failed"})
		return
	}
	c.Status(http.StatusNoContent)
}
