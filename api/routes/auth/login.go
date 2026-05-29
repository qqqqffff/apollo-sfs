package auth

import (
	"net/http"
	"strings"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/routes/middleware"
)

type loginRequest struct {
	Username string `json:"username" binding:"required,max=150"`
	Password string `json:"password" binding:"required,max=1024"`
}

// Login handles POST /api/v1/auth/login.
// Performs a Keycloak ROPC grant server-side and stores the resulting tokens in
// the HttpOnly session cookie. Returns the username in the JSON body so the
// frontend can display it without touching the token directly.
func (h *Handler) Login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username and password are required"})
		return
	}

	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username and password are required"})
		return
	}

	tokens, err := h.svc.Login(c.Request.Context(), req.Username, req.Password)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	session := sessions.DefaultMany(c, middleware.SessionName)
	session.Set("access_token", tokens.AccessToken)
	session.Set("refresh_token", tokens.RefreshToken)
	if err := session.Save(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"username": req.Username})
}
