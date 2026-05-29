package auth

import (
	"log"
	"net/http"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/routes/middleware"
)

// Logout handles POST /api/v1/auth/logout.
// Revokes the refresh token at Keycloak (invalidating the server-side session),
// then clears the local session cookie.
// Protected by RequireAuth — a valid session is required to call this endpoint.
func (h *Handler) Logout(c *gin.Context) {
	session := sessions.DefaultMany(c, middleware.SessionName)

	refreshToken, _ := session.Get("refresh_token").(string)

	// Revoke at Keycloak. Log but don't block on failure — the local session is
	// cleared regardless so the user is effectively logged out from this client.
	if refreshToken != "" {
		if err := h.svc.Logout(c.Request.Context(), refreshToken); err != nil {
			log.Printf("logout: keycloak revocation failed: %v", err)
		}
	}

	// Clear the session cookie.
	session.Clear()
	session.Options(sessions.Options{MaxAge: -1})
	if err := session.Save(); err != nil {
		log.Printf("logout: clear session: %v", err)
	}

	c.JSON(http.StatusOK, gin.H{"message": "logged out"})
}
