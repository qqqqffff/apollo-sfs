package middleware

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"
)

const (
	// rateLimitRPS is the sustained request rate allowed per IP (requests/second).
	// 10 requests per minute ≈ 0.1667 r/s.
	rateLimitRPS = rate.Limit(10.0 / 60.0)

	// rateLimitBurst is the maximum number of requests allowed in a single burst.
	rateLimitBurst = 10

	// rateLimitTTL is how long an IP's limiter is kept after its last request.
	// Entries not seen within this window are evicted by the background cleaner.
	rateLimitTTL = 10 * time.Minute

	// rateLimitCleanInterval is how often the eviction goroutine runs.
	rateLimitCleanInterval = 5 * time.Minute
)

// ipEntry holds a per-IP limiter and the last time it was accessed.
type ipEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// RateLimit returns a per-IP token-bucket rate limiter for auth endpoints.
// Sustained rate: 10 requests per minute. Burst: 10 requests.
// Client IP is derived from X-Forwarded-For set by Nginx; falls back to
// RemoteAddr when the header is absent (direct connections / local dev).
// Stale IP entries are evicted every 5 minutes to bound memory use.
func (m *AuthMiddleware) RateLimit() gin.HandlerFunc {
	var (
		mu      sync.Mutex
		entries = make(map[string]*ipEntry)
	)

	// Background goroutine: evict entries not seen within rateLimitTTL.
	go func() {
		ticker := time.NewTicker(rateLimitCleanInterval)
		defer ticker.Stop()
		for range ticker.C {
			cutoff := time.Now().Add(-rateLimitTTL)
			mu.Lock()
			for ip, e := range entries {
				if e.lastSeen.Before(cutoff) {
					delete(entries, ip)
				}
			}
			mu.Unlock()
		}
	}()

	limiterFor := func(ip string) *rate.Limiter {
		mu.Lock()
		defer mu.Unlock()
		e, ok := entries[ip]
		if !ok {
			e = &ipEntry{limiter: rate.NewLimiter(rateLimitRPS, rateLimitBurst)}
			entries[ip] = e
		}
		e.lastSeen = time.Now()
		return e.limiter
	}

	return func(c *gin.Context) {
		// X-Forwarded-For is set by Nginx; c.ClientIP() reads it and falls back
		// to RemoteAddr, honouring gin's trusted proxy configuration.
		ip := c.ClientIP()

		if !limiterFor(ip).Allow() {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error": "too many requests — please wait before trying again",
			})
			return
		}

		c.Next()
	}
}
