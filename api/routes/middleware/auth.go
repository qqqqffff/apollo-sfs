package middleware

import (
	"log"
	"net/http"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/db"
)

// SessionName is the name used when registering and retrieving the session.
// Register it once in setupRouter with:
//
//	router.Use(sessions.Sessions(middleware.SessionName, store))
const SessionName = "apollo_session"

// AuthMiddleware holds configuration shared across all middleware handlers.
// Methods are defined in the file that matches each middleware's concern.
type AuthMiddleware struct {
	verifier             *oidc.IDTokenVerifier
	queries              *db.Queries
	issuerURL            string // keycloakURL/realms/realm — used for InsecureIssuerURLContext
	keycloakURL          string // base URL, retained for token endpoint calls in ProactiveRefresh
	keycloakRealm        string
	keycloakClientID     string
	keycloakClientSecret string
	refreshThreshold     time.Duration
	cookieDomain         string
	cookieSecure         bool
}

// New creates an AuthMiddleware instance.
// verifier is constructed in main from the OIDC provider and passed in so the
// middleware does not need to know about provider setup.
func New(
	verifier *oidc.IDTokenVerifier,
	queries *db.Queries,
	keycloakURL, realm, clientID, clientSecret string,
	refreshThreshold time.Duration,
	cookieDomain string,
	cookieSecure bool,
) *AuthMiddleware {
	return &AuthMiddleware{
		verifier:             verifier,
		queries:              queries,
		issuerURL:            keycloakURL + "/realms/" + realm,
		keycloakURL:          keycloakURL,
		keycloakRealm:        realm,
		keycloakClientID:     clientID,
		keycloakClientSecret: clientSecret,
		refreshThreshold:     refreshThreshold,
		cookieDomain:         cookieDomain,
		cookieSecure:         cookieSecure,
	}
}

// keycloakClaims represents the JWT claims issued by Keycloak.
type keycloakClaims struct {
	Sub               string `json:"sub"`
	PreferredUsername string `json:"preferred_username"`
	Exp               int64  `json:"exp"`
	RealmAccess       struct {
		Roles []string `json:"roles"`
	} `json:"realm_access"`
}

// RequireAuth reads the access_token from the session, verifies its signature
// and expiry using the Keycloak JWKS, then injects the following keys into the
// Gin context for use by downstream middleware and handlers:
//
//   - "username" string   — preferred_username claim
//   - "userID"   string   — Keycloak subject claim (sub)
//   - "exp"      int64    — token expiry Unix timestamp (consumed by ProactiveRefresh)
//   - "roles"    []string — realm_access.roles claim (consumed by RequireAdmin)
//
// Returns 401 when the session carries no token or the token is invalid/expired.
// Also updates last_seen_at on every successful request (best-effort, non-blocking).
func (m *AuthMiddleware) RequireAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		session := sessions.DefaultMany(c, SessionName)

		accessToken, ok := session.Get("access_token").(string)
		if !ok || accessToken == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}

		// InsecureIssuerURLContext lets the verifier accept tokens whose issuer
		// claim contains the public hostname while JWKS were fetched from the
		// internal Docker URL. Without this, issuer validation fails when the
		// Keycloak internal URL differs from the public-facing hostname.
		ctx := oidc.InsecureIssuerURLContext(c.Request.Context(), m.issuerURL)

		idToken, err := m.verifier.Verify(ctx, accessToken)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired token"})
			return
		}

		var claims keycloakClaims
		if err := idToken.Claims(&claims); err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token claims"})
			return
		}

		c.Set("userID", claims.Sub)
		c.Set("username", claims.PreferredUsername)
		c.Set("exp", claims.Exp)
		c.Set("roles", claims.RealmAccess.Roles)

		// Update last_seen_at best-effort — a DB hiccup should never block a request.
		if err := m.queries.UpdateLastSeenAt(c.Request.Context(), claims.PreferredUsername); err != nil {
			log.Printf("RequireAuth: update last_seen_at for %q: %v", claims.PreferredUsername, err)
		}

		c.Next()
	}
}
