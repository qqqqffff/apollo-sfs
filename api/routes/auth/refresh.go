package auth

import (
	"net/http"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/routes/middleware"
)

// Refresh handles POST /api/v1/auth/refresh.
// Exchanges the refresh token stored in the session for a new token pair and
// updates the session. This is the explicit client-driven refresh; the
// ProactiveRefresh middleware handles silent background refreshes automatically.
func (h *Handler) Refresh(c *gin.Context) {
	session := sessions.DefaultMany(c, middleware.SessionName)

	refreshToken, ok := session.Get("refresh_token").(string)
	if !ok || refreshToken == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "no refresh token in session"})
		return
	}

	tokens, err := h.svc.Refresh(c.Request.Context(), refreshToken)
	if err != nil {
		// Refresh token invalid or expired — force re-login.
		session.Clear()
		session.Options(sessions.Options{MaxAge: -1})
		_ = session.Save()
		c.JSON(http.StatusUnauthorized, gin.H{"error": "session expired, please log in again"})
		return
	}

	session.Set("access_token", tokens.AccessToken)
	session.Set("refresh_token", tokens.RefreshToken)
	if err := session.Save(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "token refreshed"})
}
