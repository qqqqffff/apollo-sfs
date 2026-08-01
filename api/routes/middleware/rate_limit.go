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

	// bulkRateLimitRPS is the sustained rate for the authenticated bulk data
	// path (see bulkDataRoutes). A backup or a multi-select delete issues one
	// request per file back-to-back, so the general 2 r/s budget throttles a
	// perfectly legitimate client within a handful of files.
	// 1200 requests per minute = 20 r/s.
	bulkRateLimitRPS = rate.Limit(1200.0 / 60.0)

	// bulkRateLimitBurst is the burst allowance for the bulk data path.
	bulkRateLimitBurst = 60

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
	return newKeyLimiter(rps, burst, func(c *gin.Context) string { return c.ClientIP() })
}

// newKeyLimiter builds a gin middleware with a token-bucket rate limiter per
// key(c) — the client IP for anonymous traffic, the user id where the caller
// is already authenticated. A background goroutine evicts entries not seen
// within rateLimitTTL.
func newKeyLimiter(rps rate.Limit, burst int, key func(*gin.Context) string) gin.HandlerFunc {
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
		if !limiterFor(key(c)).Allow() {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error": "too many requests — please wait before trying again",
			})
			return
		}
		c.Next()
	}
}

// bulkDataRoutes are the authenticated endpoints a single legitimate client
// hits in a tight per-item loop: the Google/email backup flows (one upload —
// and, for Google, one dedupe probe — per file), a cancelled backup's rollback,
// and multi-select delete. They get their own, far more generous per-user
// budget; every other protected endpoint keeps the standard per-IP one. Abuse
// here is already bounded by the storage quota these same endpoints enforce.
//
// Keys are "METHOD <gin route pattern>" — i.e. what c.FullPath() returns, so
// path parameters stay unexpanded.
var bulkDataRoutes = map[string]struct{}{
	"POST /api/v1/files/upload":                     {},
	"POST /api/v1/files/upload/init":                {},
	"POST /api/v1/files/upload/:upload_id/chunk":    {},
	"POST /api/v1/files/upload/:upload_id/complete": {},
	"POST /api/v1/sync/check-hash":                  {},
	"POST /api/v1/email-backup/messages":            {},
	"DELETE /api/v1/email-backup/messages/:id":      {},
	"DELETE /api/v1/files/:file_id":                 {},
}

func isBulkDataRoute(c *gin.Context) bool {
	_, ok := bulkDataRoutes[c.Request.Method+" "+c.FullPath()]
	return ok
}

// rateLimitKey identifies the caller for limiting purposes: the authenticated
// user id when RequireAuth has already run (so one user on a shared IP — or
// behind a proxy that collapses many clients onto one address — can't exhaust
// another's budget), else the client IP.
func rateLimitKey(c *gin.Context) string {
	if userID := c.GetString("userID"); userID != "" {
		return "user:" + userID
	}
	return "ip:" + c.ClientIP()
}

// RateLimit returns a per-IP token-bucket rate limiter for auth endpoints.
// Sustained rate: 10 req/min. Burst: 10 requests.
func (m *AuthMiddleware) RateLimit() gin.HandlerFunc {
	return newIPLimiter(rateLimitRPS, rateLimitBurst)
}

// APIRateLimit returns a token-bucket rate limiter for authenticated API
// endpoints. Sustained rate: 120 req/min per IP, burst 20 — except for the
// bulk data path (bulkDataRoutes), which is limited per user at 1200 req/min,
// burst 60, so a backup or bulk delete isn't throttled a few files in.
func (m *AuthMiddleware) APIRateLimit() gin.HandlerFunc {
	standard := newIPLimiter(apiRateLimitRPS, apiRateLimitBurst)
	bulk := newKeyLimiter(bulkRateLimitRPS, bulkRateLimitBurst, rateLimitKey)
	return func(c *gin.Context) {
		if isBulkDataRoute(c) {
			bulk(c)
			return
		}
		standard(c)
	}
}
