package middleware

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// newLimitedRouter builds a router guarded by APIRateLimit. The stub in front
// of it sets userID from a header, standing in for RequireAuth, which has
// always run by the time the limiter does.
func newLimitedRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	m := &AuthMiddleware{}
	r.Use(func(c *gin.Context) {
		if userID := c.GetHeader("X-Test-User"); userID != "" {
			c.Set("userID", userID)
		}
		c.Next()
	}, m.APIRateLimit())
	handler := func(c *gin.Context) { c.Status(http.StatusOK) }
	r.POST("/api/v1/files/upload", handler)
	r.POST("/api/v1/sync/check-hash", handler)
	r.POST("/api/v1/email-backup/messages", handler)
	r.DELETE("/api/v1/files/:file_id", handler)
	r.GET("/api/v1/me", handler)
	return r
}

// countAllowed reports how many of n back-to-back requests got through.
func countAllowed(r *gin.Engine, method, path, ip, userID string, n int) int {
	allowed := 0
	for i := 0; i < n; i++ {
		req := httptest.NewRequest(method, path, nil)
		req.RemoteAddr = ip + ":12345"
		req.Header.Set("X-Test-User", userID)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code == http.StatusOK {
			allowed++
		}
	}
	return allowed
}

func TestAPIRateLimitThrottlesOrdinaryEndpoints(t *testing.T) {
	r := newLimitedRouter()
	// The standard bucket is 20 deep, so a 40-request burst must be cut off.
	allowed := countAllowed(r, http.MethodGet, "/api/v1/me", "10.0.0.1", "user-1", 40)
	if allowed > apiRateLimitBurst+2 {
		t.Fatalf("allowed %d requests on /me, want at most ~%d", allowed, apiRateLimitBurst)
	}
}

func TestAPIRateLimitLetsBulkBackupTrafficThrough(t *testing.T) {
	// One request per backed-up file, back to back — the case that used to
	// start returning 429s a handful of files into a Google or email backup.
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/v1/files/upload"},
		{http.MethodPost, "/api/v1/sync/check-hash"},
		{http.MethodPost, "/api/v1/email-backup/messages"},
		{http.MethodDelete, "/api/v1/files/11111111-1111-1111-1111-111111111111"},
	} {
		r := newLimitedRouter()
		allowed := countAllowed(r, tc.method, tc.path, "10.0.0.1", "user-1", bulkRateLimitBurst)
		if allowed != bulkRateLimitBurst {
			t.Errorf("%s %s: allowed %d of %d burst requests", tc.method, tc.path, allowed, bulkRateLimitBurst)
		}
	}
}

func TestBulkRateLimitIsPerUserNotPerIP(t *testing.T) {
	// Two users behind one address (household NAT, corporate proxy): one
	// running a backup must not spend the other's budget.
	r := newLimitedRouter()
	if first := countAllowed(r, http.MethodPost, "/api/v1/files/upload", "10.0.0.9", "user-a", bulkRateLimitBurst*2); first == 0 {
		t.Fatal("first user got nothing through")
	}
	second := countAllowed(r, http.MethodPost, "/api/v1/files/upload", "10.0.0.9", "user-b", bulkRateLimitBurst)
	if second != bulkRateLimitBurst {
		t.Errorf("second user on the same IP allowed only %d requests, want %d", second, bulkRateLimitBurst)
	}
}

// bulkDataRoutes matches on c.FullPath(), so a renamed or re-grouped route
// silently drops back to the ordinary 2 r/s budget — the exact symptom (429s
// mid-backup) this exists to prevent, with nothing failing to point at it.
func TestBulkDataRoutesStillExist(t *testing.T) {
	main, err := os.ReadFile(filepath.Join("..", "..", "cmd", "main.go"))
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	src := string(main)

	for route := range bulkDataRoutes {
		method, path, ok := strings.Cut(route, " ")
		if !ok {
			t.Fatalf("malformed bulk route key %q, want \"METHOD /path\"", route)
		}
		// Registrations are relative to the /api/v1 group.
		registration := fmt.Sprintf(`.%s("%s"`, method, strings.TrimPrefix(path, "/api/v1"))
		if !strings.Contains(src, registration) {
			t.Errorf("bulk route %q is not registered in cmd/main.go (looked for %s) — "+
				"it would fall back to the standard per-IP rate limit", route, registration)
		}
	}
}

func TestRateLimitKeyPrefersUserID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodGet, "/", nil)
	c.Request.RemoteAddr = "10.0.0.4:1111"
	if got := rateLimitKey(c); got != "ip:10.0.0.4" {
		t.Errorf("anonymous key = %q, want ip:10.0.0.4", got)
	}
	c.Set("userID", "abc")
	if got := rateLimitKey(c); got != "user:abc" {
		t.Errorf("authenticated key = %q, want user:abc", got)
	}
}
