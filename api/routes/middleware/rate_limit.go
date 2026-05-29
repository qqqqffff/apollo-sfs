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

	// apiRateLimitRPS is the sustained rate for authenticated API endpoints.
	// 120 requests per minute = 2 r/s.
	apiRateLimitRPS = rate.Limit(120.0 / 60.0)

	// apiRateLimitBurst is the burst allowance for authenticated API endpoints.
	apiRateLimitBurst = 20

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

// newIPLimiter builds a gin middleware with a per-IP token-bucket rate limiter.
// A background goroutine evicts entries not seen within rateLimitTTL.
func newIPLimiter(rps rate.Limit, burst int) gin.HandlerFunc {
	var (
		mu      sync.Mutex
		entries = make(map[string]*ipEntry)
	)

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
			e = &ipEntry{limiter: rate.NewLimiter(rps, burst)}
			entries[ip] = e
		}
		e.lastSeen = time.Now()
		return e.limiter
	}

	return func(c *gin.Context) {
		if !limiterFor(c.ClientIP()).Allow() {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error": "too many requests — please wait before trying again",
			})
			return
		}
		c.Next()
	}
}

// RateLimit returns a per-IP token-bucket rate limiter for auth endpoints.
// Sustained rate: 10 req/min. Burst: 10 requests.
func (m *AuthMiddleware) RateLimit() gin.HandlerFunc {
	return newIPLimiter(rateLimitRPS, rateLimitBurst)
}

// APIRateLimit returns a per-IP token-bucket rate limiter for authenticated API endpoints.
// Sustained rate: 120 req/min. Burst: 20 requests.
func (m *AuthMiddleware) APIRateLimit() gin.HandlerFunc {
	return newIPLimiter(apiRateLimitRPS, apiRateLimitBurst)
}
