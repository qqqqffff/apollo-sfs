package middleware

import (
	"sync"
	"time"
)

// accessTokenCache holds minted Keycloak access tokens in memory, keyed by the
// refresh token they were derived from.
//
// Web clients store ONLY the (small) refresh token in their session cookie; the
// larger access token would otherwise push the cookie past the 4 KB browser
// limit. The middleware mints an access token from the refresh token and caches
// it here so subsequent requests don't hit Keycloak again until it expires.
//
// The cache is purely an optimisation: it is rebuilt lazily after a restart from
// the refresh token each client still holds in its cookie, so users stay logged
// in across redeploys (unlike an in-memory session store, which would log them
// out). It is per-process; with a single API replica that's exactly one cache.
type accessTokenCache struct {
	mu sync.RWMutex
	m  map[string]cachedAccessToken
}

type cachedAccessToken struct {
	accessToken string
	expiresAt   time.Time
}

// earlyExpiry treats a token as expired slightly before its real expiry so a
// cached token is never handed out only to expire mid-request.
const earlyExpiry = 30 * time.Second

// cacheSweepThreshold bounds memory: once the map grows past this, expired
// entries are evicted on the next write.
const cacheSweepThreshold = 256

func newAccessTokenCache() *accessTokenCache {
	return &accessTokenCache{m: make(map[string]cachedAccessToken)}
}

// get returns a still-valid cached access token for refreshToken, or "".
func (c *accessTokenCache) get(refreshToken string) string {
	if refreshToken == "" {
		return ""
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	ct, ok := c.m[refreshToken]
	if !ok || time.Now().After(ct.expiresAt.Add(-earlyExpiry)) {
		return ""
	}
	return ct.accessToken
}

// set caches accessToken under refreshToken until expiresAt, opportunistically
// evicting expired entries to keep memory bounded.
func (c *accessTokenCache) set(refreshToken, accessToken string, expiresAt time.Time) {
	if refreshToken == "" || accessToken == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) > cacheSweepThreshold {
		now := time.Now()
		for k, v := range c.m {
			if now.After(v.expiresAt) {
				delete(c.m, k)
			}
		}
	}
	c.m[refreshToken] = cachedAccessToken{accessToken: accessToken, expiresAt: expiresAt}
}
