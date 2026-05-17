package admin

import (
	"sync"
	"sync/atomic"

	"github.com/oschwald/geoip2-golang"

	"apollo-sfs.com/api/routes/services"
)

// Handler holds dependencies for all /api/v1/admin/* endpoints.
type Handler struct {
	queries  AdminQuerier
	invites  AdminInviteService
	metrics  *services.MetricsService
	auth     *services.AuthService
	registry *services.MinIORegistry
	geo      *geoip2.Reader
	// apiDir is the absolute path to the api/ source directory used by RunTests.
	// Requires the Go toolchain in PATH. Empty disables the backend test suite.
	apiDir string
	// frontendTestURL is the POST endpoint of the frontend-tests sidecar container.
	// e.g. "http://frontend-tests:9229/run-tests". Empty disables the frontend suite.
	frontendTestURL string

	// Speed test state — protected by speedTestMu; running flag uses atomic CAS.
	speedTestMu      sync.RWMutex
	latestSpeedTest  *SpeedTestResult
	speedTestRunning atomic.Bool

	// shutdownCh, when closed, signals main to initiate graceful HTTP shutdown.
	// nil means the kill-switch endpoint is disabled.
	shutdownCh   chan struct{}
	shutdownOnce sync.Once
}

// NewHandler constructs an admin Handler.
// apiDir:          absolute path to the api/ source directory (APP_DIR env var). "" disables backend tests.
// frontendTestURL: internal URL of the frontend-tests sidecar (FRONTEND_TEST_URL env var). "" disables frontend tests.
// shutdownCh:      channel closed by the Shutdown endpoint to trigger graceful server exit. nil disables the endpoint.
func NewHandler(queries AdminQuerier, inviteSvc AdminInviteService, metricsSvc *services.MetricsService, authSvc *services.AuthService, registry *services.MinIORegistry, geoReader *geoip2.Reader, apiDir, frontendTestURL string, shutdownCh chan struct{}) *Handler {
	return &Handler{queries: queries, invites: inviteSvc, metrics: metricsSvc, auth: authSvc, registry: registry, geo: geoReader, apiDir: apiDir, frontendTestURL: frontendTestURL, shutdownCh: shutdownCh}
}
