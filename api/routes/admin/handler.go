package admin

import (
	"sync"
	"sync/atomic"

	"github.com/oschwald/geoip2-golang"

	"apollo-sfs.com/api/routes/services"
)

// Compile-time check: Handler satisfies SpeedTestProvider used by AlarmService.
var _ services.SpeedTestProvider = (*Handler)(nil)

// Handler holds dependencies for all /api/v1/admin/* endpoints.
type Handler struct {
	queries  AdminQuerier
	invites  AdminInviteService
	metrics  MetricsServicer
	auth     *services.AuthService
	registry *services.MinIORegistry
	geo      *geoip2.Reader
	// backendTestURL is the POST endpoint of the api-tests sidecar container.
	// e.g. "http://api-tests:9228/run-tests". Takes precedence over apiDir.
	backendTestURL string
	// apiDir is the absolute path to the api/ source directory used by RunTests.
	// Requires the Go toolchain in PATH. Used for local dev when backendTestURL is unset.
	apiDir string
	// frontendTestURL is the POST endpoint of the frontend-tests sidecar container.
	// e.g. "http://frontend-tests:9229/run-tests". Empty disables the frontend suite.
	frontendTestURL string
	// frontendE2EURL is the POST endpoint for the Playwright E2E suite.
	// e.g. "http://frontend-tests:9229/run-e2e". Empty disables the E2E suite.
	frontendE2EURL string

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
// backendTestURL:  internal URL of the api-tests sidecar (BACKEND_TEST_URL env var). Takes precedence over apiDir.
// apiDir:          absolute path to the api/ source directory (APP_DIR env var). Used for local dev when backendTestURL is unset.
// frontendTestURL: internal URL of the Jest sidecar (FRONTEND_TEST_URL env var). "" disables unit tests.
// frontendE2EURL:  internal URL of the Playwright sidecar (FRONTEND_E2E_URL env var). "" disables E2E tests.
// shutdownCh:      channel closed by the Shutdown endpoint to trigger graceful server exit. nil disables the endpoint.
func NewHandler(queries AdminQuerier, inviteSvc AdminInviteService, metricsSvc MetricsServicer, authSvc *services.AuthService, registry *services.MinIORegistry, geoReader *geoip2.Reader, backendTestURL, apiDir, frontendTestURL, frontendE2EURL string, shutdownCh chan struct{}) *Handler {
	return &Handler{queries: queries, invites: inviteSvc, metrics: metricsSvc, auth: authSvc, registry: registry, geo: geoReader, backendTestURL: backendTestURL, apiDir: apiDir, frontendTestURL: frontendTestURL, frontendE2EURL: frontendE2EURL, shutdownCh: shutdownCh}
}
