package auth

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
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

type mobileGoogleRequest struct {
	// ServerAuthCode is preferred: the one-time OAuth code from GoogleSignin.signIn()
	// on iOS. The backend exchanges it with Google to get an id_token whose audience
	// is the web client ID, which Keycloak's Google IdP accepts.
	// IDToken is the fallback for flows where only the raw token is available.
	ServerAuthCode string `json:"server_auth_code"`
	IDToken        string `json:"id_token"`
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
// Prefers server_auth_code: exchanges it with Google to get an id_token whose
// audience matches the Keycloak Google IdP client ID (web client). Falls back to
// using id_token directly when server_auth_code is absent.
func (h *Handler) MobileGoogleLogin(c *gin.Context) {
	var req mobileGoogleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "request body required"})
		return
	}
	if req.ServerAuthCode == "" && req.IDToken == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "server_auth_code or id_token is required"})
		return
	}

	idToken := req.IDToken
	if req.ServerAuthCode != "" {
		exchanged, err := h.svc.ExchangeGoogleServerAuthCode(c.Request.Context(), req.ServerAuthCode)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "google auth code exchange failed: " + err.Error()})
			return
		}
		idToken = exchanged
	}

	tokens, err := h.svc.SocialLogin(c.Request.Context(), "google", idToken)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "google authentication failed: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, tokenResponse{
		AccessToken:      tokens.AccessToken,
		RefreshToken:     tokens.RefreshToken,
		ExpiresIn:        tokens.ExpiresIn,
		RefreshExpiresIn: tokens.RefreshExpiresIn,
	})
}
