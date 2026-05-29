package middleware

import (
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

// APIKeyMiddleware wires the SFS API key chain. It is constructed once at
// startup and shares the underlying APIKeyService with the management
// handlers (/api/v1/me/api-keys) so issuance, listing, and revocation use
// the same code path that Verify reads from.
type APIKeyMiddleware struct {
	svc *services.APIKeyService
}

// NewAPIKeyMiddleware builds a middleware backed by svc.
func NewAPIKeyMiddleware(svc *services.APIKeyService) *APIKeyMiddleware {
	return &APIKeyMiddleware{svc: svc}
}

// Gin context keys populated by RequireAPIKey on success.
const (
	CtxAPIKey       = "apiKey"
	CtxAPIKeyID     = "apiKeyID"
	CtxAPIKeyScopes = "apiKeyScopes"
	CtxAPIKeyUser   = "apiKeyUser"
)

// RequireAPIKey parses `Authorization: Bearer <raw>` and validates the
// token via APIKeyService.Verify. Successful auth populates the Gin
// context with the key, scopes, and the owning user. All failure modes
// collapse to 401 to avoid leaking which keys exist.
func (m *APIKeyMiddleware) RequireAPIKey() gin.HandlerFunc {
	return func(c *gin.Context) {
		raw := extractBearer(c)
		if raw == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing api key"})
			return
		}
		result, err := m.svc.Verify(c.Request.Context(), raw)
		if err != nil {
			switch {
			case errors.Is(err, services.ErrAPIKeyMalformed),
				errors.Is(err, services.ErrAPIKeyNotFound),
				errors.Is(err, services.ErrAPIKeyRevoked),
				errors.Is(err, services.ErrAPIKeyExpired),
				errors.Is(err, services.ErrAPIKeyOwnerNotFound):
				c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid api key"})
				return
			default:
				log.Printf("RequireAPIKey: verify: %v", err)
				c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
				return
			}
		}
		c.Set(CtxAPIKey, result.Key)
		c.Set(CtxAPIKeyID, result.Key.ID)
		c.Set(CtxAPIKeyScopes, result.Scopes)
		c.Set(CtxAPIKeyUser, result.User)
		c.Next()
	}
}

// RequirePremiumAPI asserts the API key's owner is premium or admin.
// Returns 402 Payment Required for free users so clients can show a
// targeted upgrade prompt.
func (m *APIKeyMiddleware) RequirePremiumAPI() gin.HandlerFunc {
	return func(c *gin.Context) {
		raw, ok := c.Get(CtxAPIKeyUser)
		if !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing api key"})
			return
		}
		user, ok := raw.(*models.User)
		if !ok {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "invalid api key context"})
			return
		}
		if !(user.IsPremium || user.IsAdmin) {
			c.AbortWithStatusJSON(http.StatusPaymentRequired, gin.H{"error": "premium tier required"})
			return
		}
		c.Next()
	}
}

// extractBearer reads the token from `Authorization: Bearer <token>`.
func extractBearer(c *gin.Context) string {
	h := c.GetHeader("Authorization")
	if h == "" {
		return ""
	}
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return ""
	}
	return strings.TrimSpace(h[len(prefix):])
}
