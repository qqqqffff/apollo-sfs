package admin

import (
	"sync"
	"sync/atomic"

	"github.com/oschwald/geoip2-golang"

	"apollo-sfs.com/api/routes"
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
	files    routes.FileServicer
	registry *services.MinIORegistry
	geo      *geoip2.Reader
	// swarm and storage drive the infrastructure sync: swarm enumerates Docker
	// Swarm nodes (manager/worker, tier label); storage reads each MinIO
	// instance's buckets and capacity. Both are interfaces so the sync is testable.
	swarm   services.SwarmInspector
	storage services.StorageInspector
	// minioStandardEndpoint is the standard-tier MinIO endpoint (MINIO_STANDARD_ENDPOINT).
	// Empty when the deployment has a single MinIO instance (e.g. local dev).
	minioStandardEndpoint string
	// minioEndpoint / minioUseSSL describe the primary (fast) MinIO instance, used
	// by the sync to register/refresh its server row.
	minioEndpoint string
	minioAccessKey string
	minioSecretKey string
	minioUseSSL    bool
	// minioBucketName is the configured shared bucket each MinIO instance hosts
	// (MINIO_BUCKET_NAME). The sync reconciles one drive per tier against this
	// bucket rather than enumerating every bucket (which surfaces user
	// sub-directories as phantom drives).
	minioBucketName string
	// diskStatsPath is the filesystem path used to auto-detect drive capacity
	// for the sync-capacity endpoint (e.g. "/data" inside the container).
	diskStatsPath string
	// diskStatsLabel is the filesystem label of the volume mounted at
	// diskStatsPath (DISK_STATS_DRIVE_LABEL). The live drive-stats endpoint maps
	// the drive carrying this label to diskStatsPath, which the container can
	// always read, instead of relying on host mount discovery.
	diskStatsLabel string
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

	// paypal is used to refund the interest-form deposit when a submission is
	// denied. nil is tolerated and causes DenyInterestSubmission to 503.
	paypal *services.PayPalClient
}

// NewHandler constructs an admin Handler.
// diskStatsPath:   filesystem path to auto-detect drive capacity (DISK_STATS_PATH env var, e.g. "/data").
// diskStatsLabel:  filesystem label of the volume at diskStatsPath (DISK_STATS_DRIVE_LABEL env var).
// backendTestURL:  internal URL of the api-tests sidecar (BACKEND_TEST_URL env var). Takes precedence over apiDir.
// apiDir:          absolute path to the api/ source directory (APP_DIR env var). Used for local dev when backendTestURL is unset.
// frontendTestURL: internal URL of the Jest sidecar (FRONTEND_TEST_URL env var). "" disables unit tests.
// frontendE2EURL:  internal URL of the Playwright sidecar (FRONTEND_E2E_URL env var). "" disables E2E tests.
// shutdownCh:      channel closed by the Shutdown endpoint to trigger graceful server exit. nil disables the endpoint.
func NewHandler(queries AdminQuerier, inviteSvc AdminInviteService, metricsSvc MetricsServicer, authSvc *services.AuthService, fileSvc routes.FileServicer, registry *services.MinIORegistry, geoReader *geoip2.Reader, diskStatsPath, diskStatsLabel, backendTestURL, apiDir, frontendTestURL, frontendE2EURL string, shutdownCh chan struct{}) *Handler {
	return &Handler{queries: queries, invites: inviteSvc, metrics: metricsSvc, auth: authSvc, files: fileSvc, registry: registry, geo: geoReader, diskStatsPath: diskStatsPath, diskStatsLabel: diskStatsLabel, backendTestURL: backendTestURL, apiDir: apiDir, frontendTestURL: frontendTestURL, frontendE2EURL: frontendE2EURL, shutdownCh: shutdownCh}
}

// InfraSyncConfig configures the on-demand infrastructure sync (POST /system/sync).
type InfraSyncConfig struct {
	Swarm   services.SwarmInspector
	Storage services.StorageInspector
	// Primary (fast-tier) MinIO instance — the API's own MINIO_* credentials.
	MinIOEndpoint  string
	MinIOAccessKey string
	MinIOSecretKey string
	MinIOUseSSL    bool
	// MinIOBucketName is the shared bucket each MinIO instance hosts (MINIO_BUCKET_NAME).
	MinIOBucketName string
	// StandardEndpoint is the standard-tier MinIO endpoint (MINIO_STANDARD_ENDPOINT),
	// reachable with the same root credentials. Empty for single-instance deployments.
	StandardEndpoint string
}

// SetPayPalClient installs the PayPal client used to refund interest-form
// deposits on denial. Wired from main once the client is constructed; nil is
// tolerated and causes DenyInterestSubmission to return 503.
func (h *Handler) SetPayPalClient(client *services.PayPalClient) {
	h.paypal = client
}

// ConfigureInfraSync attaches the swarm/storage inspectors and MinIO connection
// details used by SyncInfrastructure. Call once at startup after NewHandler.
func (h *Handler) ConfigureInfraSync(c InfraSyncConfig) {
	h.swarm = c.Swarm
	h.storage = c.Storage
	h.minioEndpoint = c.MinIOEndpoint
	h.minioAccessKey = c.MinIOAccessKey
	h.minioSecretKey = c.MinIOSecretKey
	h.minioUseSSL = c.MinIOUseSSL
	h.minioBucketName = c.MinIOBucketName
	h.minioStandardEndpoint = c.StandardEndpoint
}
