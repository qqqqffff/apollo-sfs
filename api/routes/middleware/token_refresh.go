package middleware

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"
)

// keycloakTokenResponse is the relevant subset of Keycloak's token endpoint
// response used during a refresh grant.
type keycloakTokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
}

// ProactiveRefresh silently refreshes the access token when it is within
// m.refreshThreshold of expiring. Runs after RequireAuth on every protected
// request so the client never faces an unexpected 401 during normal usage.
//
// Flow:
//  1. Read "exp" (int64 Unix timestamp) from Gin context (set by RequireAuth).
//  2. If remaining TTL > m.refreshThreshold → pass through unchanged.
//  3. Acquire a per-username in-flight lock via sync.Map to deduplicate
//     concurrent requests — only one goroutine calls Keycloak at a time.
//  4. Read the refresh_token from the session.
//  5. POST refresh_token grant to the Keycloak token endpoint.
//  6. On success → write new access_token + refresh_token into the session
//     and call session.Save() so the updated cookie is set on the response.
//  7. On failure → set X-Token-Refresh-Failed: true and continue — the current
//     access token is still valid for its remaining TTL.
func (m *AuthMiddleware) ProactiveRefresh() gin.HandlerFunc {
	var inFlight sync.Map // key: username string, value: struct{}

	return func(c *gin.Context) {
		// 1. Check expiry from context set by RequireAuth.
		expVal, exists := c.Get("exp")
		if !exists {
			c.Next()
			return
		}
		exp, ok := expVal.(int64)
		if !ok {
			c.Next()
			return
		}

		// 2. Skip if there is still plenty of time left.
		remaining := time.Until(time.Unix(exp, 0))
		if remaining > m.refreshThreshold {
			c.Next()
			return
		}

		// 3. Deduplicate: only one request per user triggers a refresh.
		usernameVal, _ := c.Get("username")
		username, _ := usernameVal.(string)

		if _, alreadyRunning := inFlight.LoadOrStore(username, struct{}{}); alreadyRunning {
			c.Next()
			return
		}
		defer inFlight.Delete(username)

		// 4. Read the refresh token from the session.
		session := sessions.DefaultMany(c, SessionName)
		refreshToken, ok := session.Get("refresh_token").(string)
		if !ok || refreshToken == "" {
			// No refresh token stored — nothing we can do, let the request proceed.
			c.Next()
			return
		}

		// 5. Call Keycloak.
		tokens, err := m.callRefreshGrant(c.Request.Context(), refreshToken)
		if err != nil {
			log.Printf("ProactiveRefresh: %q: %v", username, err)
			c.Header("X-Token-Refresh-Failed", "true")
			c.Next()
			return
		}

		// 6. Persist the new tokens in the session.
		session.Set("access_token", tokens.AccessToken)
		session.Set("refresh_token", tokens.RefreshToken)
		if err := session.Save(); err != nil {
			log.Printf("ProactiveRefresh: save session for %q: %v", username, err)
		}

		c.Next()
	}
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

	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, tokenURL,
		strings.NewReader(body.Encode()),
	)
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
