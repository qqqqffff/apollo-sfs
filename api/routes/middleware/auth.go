package middleware

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/db"
)

// errMintRequired signals that no access token was available (web session with
// an empty cache) and one must be minted from the refresh token.
var errMintRequired = errors.New("access token must be minted from refresh token")

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

// SandboxEnabled reports whether the current request's admin has the
// session-scoped "sandbox payments" toggle on (set by RequireAuth from the
// session cookie). Always false for non-admins and for Bearer/mobile
// requests, which carry no session cookie.
func SandboxEnabled(c *gin.Context) bool {
	v, _ := c.Get("sandboxPaymentsEnabled")
	enabled, _ := v.(bool)
	return enabled
}

// ExpansionOverrideEnabled reports whether the calling admin's session-scoped
// "always request server expansion" toggle is on (see UpdateExpansionOverride).
func ExpansionOverrideEnabled(c *gin.Context) bool {
	v, _ := c.Get("expansionOverrideEnabled")
	enabled, _ := v.(bool)
	return enabled
}

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
	// tokenCache holds access tokens minted from web-session refresh tokens, so
	// the cookie only needs to carry the refresh token (under the 4 KB limit).
	tokenCache *accessTokenCache
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
		tokenCache:           newAccessTokenCache(),
	}
}

// roleSetHas reports whether the slice contains the target role.
// Used by RequireAuth to populate the isPremium gin context value.
func roleSetHas(roles []string, target string) bool {
	for _, r := range roles {
		if r == target {
			return true
		}
	}
	return false
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

// RequirePremium returns a middleware that gates access to premium-only routes.
// Must be chained after RequireAuth so that "isPremium" is present in context.
// Returns 402 Payment Required for authenticated non-premium users.
func (m *AuthMiddleware) RequirePremium() gin.HandlerFunc {
	return func(c *gin.Context) {
		if ok, _ := c.Get("isPremium"); ok != true {
			c.AbortWithStatusJSON(http.StatusPaymentRequired, gin.H{"error": "premium subscription required"})
			return
		}
		c.Next()
	}
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
//   - "username"              string   — preferred_username claim
//   - "userID"                string   — Keycloak subject claim (sub)
//   - "exp"                   int64    — token expiry Unix timestamp (consumed by ProactiveRefresh)
//   - "roles"                 []string — realm_access.roles claim (consumed by RequireAdmin)
//   - "isAdmin"                bool    — realm_access.roles contains "admin"
//   - "sandboxPaymentsEnabled" bool    — admin's session-scoped sandbox-payments toggle (see SandboxEnabled)
//   - "expansionOverrideEnabled" bool  — admin's session-scoped expansion-request-override toggle (see ExpansionOverrideEnabled)
//
// Returns 401 when no valid credentials are present.
// Also updates last_seen_at on every successful request (best-effort, non-blocking).
func (m *AuthMiddleware) RequireAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		var accessToken, refreshToken string
		useBearerPath := false
		webSession := false

		if h := c.GetHeader("Authorization"); strings.HasPrefix(h, "Bearer ") {
			accessToken = strings.TrimPrefix(h, "Bearer ")
			refreshToken = c.GetHeader("X-Refresh-Token")
			useBearerPath = true
		} else {
			// Web clients store only the (small) refresh token in the cookie; the
			// access token is minted from it and kept in tokenCache, keeping the
			// cookie under the 4 KB limit.
			session := sessions.DefaultMany(c, SessionName)
			refreshToken, _ = session.Get("refresh_token").(string)
			accessToken = m.tokenCache.get(refreshToken)
			webSession = true
		}

		// Bearer (mobile) clients must present an access token; web clients may
		// arrive with only a refresh token and have one minted below.
		if (useBearerPath && accessToken == "") || (accessToken == "" && refreshToken == "") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}

		var idToken *oidc.IDToken
		err := errMintRequired
		if accessToken != "" {
			idToken, err = m.verifier.Verify(c.Request.Context(), accessToken)
		}
		minted := false
		if err != nil {
			// No cached token, or it expired — mint a fresh pair from the refresh token.
			if refreshToken != "" {
				if tokens, refreshErr := m.callRefreshGrant(c.Request.Context(), refreshToken); refreshErr == nil {
					accessToken = tokens.AccessToken
					newRefresh := tokens.RefreshToken
					if newRefresh == "" {
						newRefresh = refreshToken
					}
					if useBearerPath {
						c.Header("X-New-Access-Token", tokens.AccessToken)
						c.Header("X-New-Refresh-Token", newRefresh)
					} else if newRefresh != refreshToken {
						// Refresh token rotated — persist the new one in the cookie.
						session := sessions.DefaultMany(c, SessionName)
						session.Set("refresh_token", newRefresh)
						if err := session.Save(); err != nil {
							log.Printf("RequireAuth: persist rotated refresh token: %v", err)
						}
					}
					refreshToken = newRefresh
					idToken, err = m.verifier.Verify(c.Request.Context(), tokens.AccessToken)
					minted = err == nil
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

		// Cache the freshly minted access token for this web session so the next
		// request is served without another Keycloak round-trip, until it expires.
		if webSession && minted {
			m.tokenCache.set(refreshToken, accessToken, time.Unix(claims.Exp, 0))
		}

		c.Set("userID", claims.Sub)
		c.Set("username", claims.PreferredUsername)
		c.Set("exp", claims.Exp)
		c.Set("roles", claims.RealmAccess.Roles)
		c.Set("isPremium", roleSetHas(claims.RealmAccess.Roles, "premium") ||
			roleSetHas(claims.RealmAccess.Roles, "admin"))

		// Update last_seen_at and sync is_admin / is_premium from JWT realm
		// roles — best-effort, non-blocking. Premium is granted via Keycloak
		// group membership (the "premium" realm group carries the "premium"
		// role); admins also implicitly receive premium downstream.
		isAdmin, isPremium := false, false
		for _, r := range claims.RealmAccess.Roles {
			switch r {
			case "admin":
				isAdmin = true
			case "premium":
				isPremium = true
			}
		}
		if isAdmin {
			isPremium = true
		}
		if err := m.queries.UpdateLastSeenAt(c.Request.Context(), claims.PreferredUsername, isAdmin, isPremium); err != nil {
			log.Printf("RequireAuth: update last_seen_at for %q: %v", claims.PreferredUsername, err)
		}

		c.Set("isAdmin", isAdmin)

		// Sandbox-payments toggle: a session-scoped flag (not persisted to the
		// DB) set via PUT /me/sandbox-payments. ANDing with isAdmin means a
		// revoked admin role — or a stale flag from before a role change —
		// can never read back as sandbox-enabled. Bearer/mobile requests carry
		// no session cookie, so this is always false for them.
		session := sessions.DefaultMany(c, SessionName)
		sandboxFlag, _ := session.Get("sandbox_payments_enabled").(bool)
		c.Set("sandboxPaymentsEnabled", isAdmin && sandboxFlag)

		// Same session-scoped, admin-only, not-persisted-to-DB pattern as the
		// sandbox-payments toggle above, but forces the Add Storage modal to
		// always treat a purchase as a capacity expansion request instead of
		// a direct buy — useful for testing the expansion review/deposit flow
		// without needing a server actually near capacity.
		expansionFlag, _ := session.Get("expansion_override_enabled").(bool)
		c.Set("expansionOverrideEnabled", isAdmin && expansionFlag)

		c.Next()
	}
}
