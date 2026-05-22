package middleware

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/db"
)

// keycloakTokenResponse is the relevant subset of Keycloak's token endpoint
// response used during a refresh grant.
type keycloakTokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

// callRefreshGrant posts a refresh_token grant to the Keycloak token endpoint
// and returns the new access and refresh tokens on success.
func (m *AuthMiddleware) callRefreshGrant(ctx context.Context, refreshToken string) (*keycloakTokenResponse, error) {
	tokenURL := fmt.Sprintf(
		"%s/realms/%s/protocol/openid-connect/token",
		m.keycloakURL, m.keycloakRealm,
	)
	body := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {m.keycloakClientID},
		"client_secret": {m.keycloakClientSecret},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(body.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("keycloak request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("keycloak returned %s", resp.Status)
	}
	var tr keycloakTokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	if tr.AccessToken == "" {
		return nil, fmt.Errorf("empty access_token in response")
	}
	return &tr, nil
}

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
	issuerURL            string
	keycloakURL          string
	keycloakRealm        string
	keycloakClientID     string
	keycloakClientSecret string
	cookieDomain         string
	cookieSecure         bool
}

// New creates an AuthMiddleware instance.
func New(
	verifier *oidc.IDTokenVerifier,
	queries *db.Queries,
	keycloakURL, realm, clientID, clientSecret string,
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

// RequireAuth accepts an access token from either an HttpOnly session cookie
// (web clients) or an Authorization: Bearer header (mobile clients).
//
// For Bearer requests an expired token is silently refreshed if the client
// sends a valid X-Refresh-Token header; the new pair is returned in
// X-New-Access-Token / X-New-Refresh-Token response headers (no cookie is written).
//
// On success the following Gin context keys are set for downstream handlers:
//
//   - "username" string   — preferred_username claim
//   - "userID"   string   — Keycloak subject claim (sub)
//   - "exp"      int64    — token expiry Unix timestamp (consumed by ProactiveRefresh)
//   - "roles"    []string — realm_access.roles claim (consumed by RequireAdmin)
//
// Returns 401 when no valid credentials are present.
// Also updates last_seen_at on every successful request (best-effort, non-blocking).
func (m *AuthMiddleware) RequireAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		var accessToken, refreshToken string
		useBearerPath := false

		if h := c.GetHeader("Authorization"); strings.HasPrefix(h, "Bearer ") {
			accessToken = strings.TrimPrefix(h, "Bearer ")
			refreshToken = c.GetHeader("X-Refresh-Token")
			useBearerPath = true
		} else {
			session := sessions.DefaultMany(c, SessionName)
			accessToken, _ = session.Get("access_token").(string)
			refreshToken, _ = session.Get("refresh_token").(string)
		}

		if accessToken == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}

		idToken, err := m.verifier.Verify(c.Request.Context(), accessToken)
		if err != nil {
			// Access token expired — attempt a silent refresh before giving up.
			if refreshToken != "" {
				if tokens, refreshErr := m.callRefreshGrant(c.Request.Context(), refreshToken); refreshErr == nil {
					if useBearerPath {
						c.Header("X-New-Access-Token", tokens.AccessToken)
						c.Header("X-New-Refresh-Token", tokens.RefreshToken)
					} else {
						session := sessions.DefaultMany(c, SessionName)
						session.Set("access_token", tokens.AccessToken)
						session.Set("refresh_token", tokens.RefreshToken)
						_ = session.Save()
					}
					idToken, err = m.verifier.Verify(c.Request.Context(), tokens.AccessToken)
				}
			}
			if err != nil {
				c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired token"})
				return
			}
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

		// Update last_seen_at and sync is_admin from JWT — best-effort, non-blocking.
		isAdmin := false
		for _, r := range claims.RealmAccess.Roles {
			if r == "admin" {
				isAdmin = true
				break
			}
		}
		if err := m.queries.UpdateLastSeenAt(c.Request.Context(), claims.PreferredUsername, isAdmin); err != nil {
			log.Printf("RequireAuth: update last_seen_at for %q: %v", claims.PreferredUsername, err)
		}

		c.Next()
	}
}
